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
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

// Bump this together with the server's CHANNEL_LATEST whenever this file changes.
// If the server reports a newer version, we tell the operator to update.
const CHANNEL_VERSION = "0.4.0";

// This machine's name — reported on register so leaders know who's co-located
// vs on a different computer (different files). Override with MESH_HOST.
const HOST = process.env.MESH_HOST || hostname();

// Optional explicit mesh identity for this session. Set MESH_NAME=<name> at launch
// to pin the agent's name AND let the liveness hook (hooks/beat.mjs) attribute its
// beats reliably — required if you run several agents from the same directory.
const NAME = process.env.MESH_NAME || "";

// Record this session's mesh name where the liveness hook can find it (keyed by
// cwd), so an agent killed by an API error is still identifiable to the watchdog
// even without MESH_NAME set. Best-effort.
function recordName(name) {
  try {
    const dir = join(homedir(), ".mesh", "run");
    mkdirSync(dir, { recursive: true });
    const h = createHash("sha1").update(process.cwd()).digest("hex").slice(0, 16);
    writeFileSync(join(dir, h + ".name"), name);
  } catch {}
}

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

// Belt-and-suspenders: never let a stray rejection/throw take the plugin down.
// A dead plugin = the agent silently loses every mesh tool at once and drifts onto
// another mesh/connector. We'd rather log to stderr and keep serving. (stdout is the
// JSON-RPC channel, so diagnostics MUST go to stderr.)
process.on("unhandledRejection", (e) => console.error("[mesh] unhandledRejection (ignored):", e?.message || e));
process.on("uncaughtException", (e) => console.error("[mesh] uncaughtException (ignored):", e?.message || e));

let seq = 0;
// Never throws. A network blip (wifi -> hotspot -> wifi) makes fetch reject; if we
// let that propagate it becomes an unhandled rejection and Node KILLS this whole
// process — taking the mesh tools AND the live stream down at once, stranding the
// agent (it then wanders onto whatever other mesh/connector is still reachable).
// So: retry a few times over a couple seconds (a hotspot switch is usually back by
// then), and on total failure RETURN a JSON-RPC-shaped error. The tools/call handler
// already does `if (j.error) send(...isError)`, so the agent gets a clean, calm
// "retry in a sec, stay on THIS mesh" instead of a hang or a dead plugin.
const NET_ERROR =
  "mesh briefly unreachable (looks like a network change) — it auto-reconnects, " +
  "retry the same call in a few seconds. Stay on THIS mesh; do NOT switch to another " +
  "mesh or connector.";
async function httpRpc(method, params, tries = 3) {
  let lastErr;
  for (let attempt = 0; attempt < tries; attempt++) {
    if (attempt) await sleep(700 * attempt); // 0ms, 700ms, 1400ms
    try {
      const res = await fetch(MCP_URL, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${CODE}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++seq, method, params }),
        signal: AbortSignal.timeout(12000),
      });
      return await res.json();
    } catch (e) {
      lastErr = e; // network down / timed out / aborted — retry
    }
  }
  return { error: { code: -32003, message: NET_ERROR, data: String(lastErr?.message || lastErr) } };
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
    let instr = j.result?.instructions || FALLBACK_INSTRUCTIONS;
    const latest = j.result?.meshChannelLatest;
    if (latest && latest !== CHANNEL_VERSION) {
      instr =
        `IMPORTANT — the mesh channel plugin on this machine is out of date ` +
        `(installed ${CHANNEL_VERSION}, latest ${latest}). Tell the operator to run ` +
        `"claude plugin update mesh@mesh" and relaunch; some behaviour may be stale until then.\n\n` +
        instr;
    }
    return instr;
  } catch {
    return FALLBACK_INSTRUCTIONS;
  }
}

// Once we know who we are, subscribe to the live stream. The server PUSHES every
// message addressed to us the instant it's written (Postgres NOTIFY -> SSE), so
// there is no polling and delivery is sub-second. On each (re)connect we do one
// catch-up fetch to fill any gap, then ride the stream. Holding the stream open
// also keeps us online (the server bumps last_seen while connected).
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const STREAM_URL = `${BASE}/api/mesh/stream`;
let me = null;
const seen = new Set(); // message ids already delivered (dedup across stream + catch-up)
let lastId = 0; // high-water mark for catch-up
let primed = false; // first catch-up only sets lastId; we don't replay the backlog on join
let streaming = false;

function deliver(m) {
  const mid = Number(m.id);
  if (mid) {
    if (seen.has(mid)) return;
    seen.add(mid);
    lastId = Math.max(lastId, mid);
  }
  const scope = (m.recipients ?? []).length ? "direct" : "broadcast";
  send({
    jsonrpc: "2.0",
    method: "notifications/claude/channel",
    params: { content: `${m.sender}: ${m.content}`, meta: { from: m.sender, to: (m.recipients ?? []).join(","), kind: scope } },
  });
}

// Fill the gap from before we (re)connected; prime (skip backlog) on first join.
async function catchUp() {
  try {
    const res = await fetch(`${POLL_URL}?name=${encodeURIComponent(me)}&since=${lastId}`, {
      headers: { authorization: `Bearer ${CODE}` },
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) return;
    const data = await res.json();
    if (!primed) {
      primed = true;
      if (typeof data.cursor === "number") lastId = data.cursor;
      return;
    }
    for (const m of data.messages ?? []) deliver(m);
    if (typeof data.cursor === "number") lastId = Math.max(lastId, data.cursor);
  } catch {
    /* the stream is primary; a failed catch-up just retries on next reconnect */
  }
}

async function streamLoop() {
  if (streaming) return; // one loop, started when we learn our name
  streaming = true;
  while (!leaving && me && CODE) {
    try {
      await catchUp();
      // NOTE: no timeout on this fetch — the SSE response is long-lived.
      const res = await fetch(`${STREAM_URL}?name=${encodeURIComponent(me)}`, {
        headers: { authorization: `Bearer ${CODE}`, accept: "text/event-stream" },
      });
      if (!res.ok || !res.body) {
        await sleep(2000);
        continue;
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      while (!leaving) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trimEnd();
          buf = buf.slice(nl + 1);
          if (line.startsWith("data:")) {
            try {
              deliver(JSON.parse(line.slice(5).trim()));
            } catch {
              /* comment/keepalive line */
            }
          }
        }
      }
    } catch {
      /* connection dropped — reconnect below */
    }
    if (!leaving) await sleep(1500);
  }
}

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
    // Learn our own name from the calls we make, then start the live stream.
    if (args && typeof args === "object") {
      // If launched with MESH_NAME, that identity is authoritative — pin the
      // register name to it so the org tree and the liveness hook always agree.
      if (params?.name === "register" && NAME) args.name = NAME;
      if (typeof args.name === "string") me = args.name;
      else if (typeof args.from === "string") me = args.from;
      if (me) {
        recordName(me); // let the liveness hook attribute beats to this agent
        streamLoop(); // idempotent — subscribes to server-push once
      }
      // tag registrations with this machine so leaders see who's co-located
      if (params?.name === "register" && !args.host) args.host = HOST;
    }
    const j = await httpRpc("tools/call", { name: params?.name, arguments: args });
    if (j.error) return send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: j.error.message }], isError: true } });
    return send({ jsonrpc: "2.0", id, result: j.result });
  }
  send({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } });
});
