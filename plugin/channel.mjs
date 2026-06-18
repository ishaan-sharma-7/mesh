#!/usr/bin/env node
// The mesh channel. Claude Code loads this per session (with the
// --dangerously-load-development-channels flag). It:
//   • declares the claude/channel capability, so mesh messages are PUSHED into
//     the session live as <channel source="mesh"> events (no polling by the agent),
//   • exposes the mesh tools by forwarding them to the hosted mesh HTTP endpoint,
//   • once you register, polls for new messages and keeps you online automatically,
//   • checks you out of the mesh when the session ends, so the board stays honest
//     (a closed session leaves immediately instead of haunting the roster).
// Zero dependencies — plain node, talks JSON-RPC over stdio.

import { createInterface } from "node:readline";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const BASE = (process.env.MESH_URL || "https://mesh-production-d83a.up.railway.app").replace(/\/+$/, "");
const MCP_URL = `${BASE}/api/mcp`;
const POLL_URL = `${BASE}/api/mesh/poll`;

// The shared mesh code: from env, or from ~/.mesh/mcp.json.
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

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

let seq = 0;
async function httpRpc(method, params) {
  const res = await fetch(MCP_URL, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${CODE}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++seq, method, params }),
    signal: AbortSignal.timeout(12000),
  });
  return res.json();
}

let toolsCache = null;
async function getTools() {
  if (toolsCache) return toolsCache;
  const j = await httpRpc("tools/list", {});
  toolsCache = j.result?.tools ?? [];
  return toolsCache;
}

// Pull the operating protocol from the server so there's a single source of
// truth (the server's MCP `instructions`). Fall back to a short version offline.
const FALLBACK_INSTRUCTIONS =
  "You are one agent on a shared mesh. Register ONCE with your name (parent = your leader if you are a worker), " +
  "call get_tree/list_peers to see who is already here, and coordinate through the mesh (send_message / inbox). " +
  "Do NOT spawn your own subagents or invent roles — leaders assign work to EXISTING peers and ask the operator if short-handed. " +
  "Escalate up one link: worker → leader → operator.";
async function getInstructions() {
  try {
    const j = await httpRpc("initialize", { protocolVersion: "2025-06-18" });
    return j.result?.instructions || FALLBACK_INSTRUCTIONS;
  } catch {
    return FALLBACK_INSTRUCTIONS;
  }
}

// Once we know who we are, poll for messages and (implicitly) heartbeat.
let me = null;
let cursor = 0;
let primed = false; // first poll just sets the cursor — push what's said AFTER we join, not the backlog
async function poll() {
  if (!me || !CODE) return;
  try {
    const res = await fetch(`${POLL_URL}?name=${encodeURIComponent(me)}&since=${cursor}`, {
      headers: { authorization: `Bearer ${CODE}` },
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) return;
    const data = await res.json();
    if (!primed) {
      primed = true;
      if (typeof data.cursor === "number") cursor = data.cursor;
      return; // skip emitting history on join
    }
    for (const m of data.messages ?? []) {
      const scope = (m.recipients ?? []).length ? "direct" : "broadcast";
      send({
        jsonrpc: "2.0",
        method: "notifications/claude/channel",
        params: { content: `${m.sender}: ${m.content}`, meta: { from: m.sender, to: (m.recipients ?? []).join(","), kind: scope } },
      });
    }
    if (typeof data.cursor === "number") cursor = data.cursor;
  } catch {
    /* transient — try again next tick */
  }
}
setInterval(poll, 2500); // tight loop so a peer's message lands within ~2-3s, not 45-90s

// When the Claude session ends, Claude closes our stdin / SIGINTs us. Check out
// the peer on the way so a closed session leaves the mesh immediately instead of
// lingering until the idle reaper. Best-effort, with a short window.
let leaving = false;
async function leaveAndExit() {
  if (leaving) return;
  leaving = true;
  if (me && CODE) {
    try {
      await Promise.race([
        httpRpc("tools/call", { name: "checkout", arguments: { name: me } }),
        new Promise((r) => setTimeout(r, 2000)),
      ]);
    } catch {
      /* best effort — the reaper is the backstop */
    }
  }
  process.exit(0);
}
process.on("SIGINT", leaveAndExit);
process.on("SIGTERM", leaveAndExit);

const rl = createInterface({ input: process.stdin });
rl.on("close", leaveAndExit); // stdin closed = session gone
rl.on("line", async (line) => {
  line = line.trim();
  if (!line) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = msg;
  if (id === undefined || id === null) return; // notification from client (e.g. initialized)

  if (method === "initialize") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: params?.protocolVersion || "2025-06-18",
        capabilities: { experimental: { "claude/channel": {} }, tools: {} },
        serverInfo: { name: "mesh", version: "0.1.0" },
        instructions: await getInstructions(),
      },
    });
    return;
  }
  if (method === "ping") return send({ jsonrpc: "2.0", id, result: {} });
  if (method === "tools/list") return send({ jsonrpc: "2.0", id, result: { tools: await getTools() } });
  if (method === "tools/call") {
    const args = params?.arguments ?? {};
    // Learn our own name from the calls we make, so the poll loop knows who we are.
    if (args && typeof args === "object") {
      if (typeof args.name === "string") me = args.name;
      else if (typeof args.from === "string") me = args.from;
    }
    const j = await httpRpc("tools/call", { name: params?.name, arguments: args });
    if (j.error) return send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: j.error.message }], isError: true } });
    return send({ jsonrpc: "2.0", id, result: j.result });
  }
  send({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } });
});
