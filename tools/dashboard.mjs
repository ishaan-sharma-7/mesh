#!/usr/bin/env node
// A tiny local dashboard for the mesh. Zero dependencies. It serves a single
// org-chart page on localhost and proxies the hosted /api/mesh/state feed
// (server-side, so no CORS and the mesh code never reaches the browser).
//   MESH_CODE=... node tools/dashboard.mjs      (or it reads ~/.mesh/mcp.json)
//   open http://localhost:4180

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const BASE = (process.env.MESH_URL || "https://mesh-production-d83a.up.railway.app").replace(/\/+$/, "");
const PORT = Number(process.env.MESH_DASH_PORT || 4180);

function readCode() {
  if (process.env.MESH_CODE) return process.env.MESH_CODE;
  try {
    const cfg = JSON.parse(readFileSync(join(homedir(), ".mesh", "mcp.json"), "utf8"));
    return (cfg.mcpServers?.mesh?.headers?.Authorization || cfg.code || "").replace(/^Bearer\s+/i, "");
  } catch {
    return "";
  }
}
const CODE = readCode();
const HTML_PATH = join(here, "dashboard.html");

// Tolerate stray control chars that old task details can leave in the JSON
// (replace any char below code point 32 with a space, then re-parse).
function parse(text) {
  try {
    return JSON.parse(text);
  } catch {
    let out = "";
    for (let i = 0; i < text.length; i++) {
      out += text.charCodeAt(i) < 32 ? " " : text[i];
    }
    try {
      return JSON.parse(out);
    } catch {
      return null;
    }
  }
}

const server = createServer(async (req, res) => {
  if (req.url === "/" || req.url.startsWith("/index")) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(readFileSync(HTML_PATH, "utf8")); // fresh each load so UI edits show on refresh
  }
  if (req.url.startsWith("/api/state")) {
    try {
      const r = await fetch(`${BASE}/api/mesh/state`, { headers: { Cookie: `mesh_code=${CODE}` }, signal: AbortSignal.timeout(12000) });
      const j = parse(await r.text());
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(j || { error: "unreadable state" }));
    } catch (e) {
      res.writeHead(502, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: String(e.message) }));
    }
  }
  res.writeHead(404);
  res.end("not found");
});

server.listen(PORT, () => {
  console.log(`\n  mesh dashboard  ->  http://localhost:${PORT}`);
  console.log(`  code: ${CODE ? "loaded" : "MISSING — set MESH_CODE or ~/.mesh/mcp.json"}\n`);
});
