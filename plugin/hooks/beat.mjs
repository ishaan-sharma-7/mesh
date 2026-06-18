#!/usr/bin/env node
// Liveness beat. A Claude Code hook runs this at every turn end (Stop), on an API
// error (StopFailure), and when the session goes idle (Notification:idle_prompt).
// It POSTs the agent's health to the mesh server from OUTSIDE the model — so an
// agent killed by an API error, which can't report its own failure, is still
// detected. The server then drives revival by code. This MUST be fast and must
// NEVER block the session: it always exits 0, even on any error.
//
// Usage (from hooks.json): node beat.mjs <stop|error|idle>
//   error_type for StopFailure is read from the hook JSON on stdin.

import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

const event = (process.argv[2] || "stop").toLowerCase(); // stop | error | idle

// MESH_CODE + MESH_URL from env or ~/.mesh/mcp.json — same resolution the channel
// plugin uses, so the hook needs no separate config.
function readCfg() {
  let code = process.env.MESH_CODE || "";
  let url = process.env.MESH_URL || "";
  try {
    const cfg = JSON.parse(readFileSync(join(homedir(), ".mesh", "mcp.json"), "utf8"));
    if (!code) code = (cfg.mcpServers?.mesh?.headers?.Authorization || cfg.code || "").replace(/^Bearer\s+/i, "");
    if (!url) url = cfg.url || "";
  } catch {}
  return { code, url: (url || "https://mesh-production-d83a.up.railway.app").replace(/\/+$/, "") };
}

async function main() {
  let raw = "";
  try { raw = readFileSync(0, "utf8"); } catch {}
  let j = {};
  try { j = JSON.parse(raw); } catch {}

  // Resolve this session's mesh name. MESH_NAME (set at launch) wins and is the
  // robust choice when several agents share a working dir. Otherwise fall back to
  // the name the channel plugin wrote for this cwd.
  let name = process.env.MESH_NAME || "";
  if (!name) {
    const cwd = j.cwd || process.cwd();
    const h = createHash("sha1").update(cwd).digest("hex").slice(0, 16);
    const f = join(homedir(), ".mesh", "run", h + ".name");
    if (existsSync(f)) { try { name = readFileSync(f, "utf8").trim(); } catch {} }
  }
  if (!name) return; // can't attribute this beat — drop it

  const { code, url } = readCfg();
  if (!code) return;

  const error_type = event === "error" ? (j.error_type || "unknown") : undefined;
  try {
    await fetch(`${url}/api/mesh/beat`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${code}` },
      body: JSON.stringify({ name, event, error_type }),
      signal: AbortSignal.timeout(6000),
    });
  } catch {}
}

main().finally(() => process.exit(0));
