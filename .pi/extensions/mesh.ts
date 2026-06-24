// Pi bridge for the mesh.
//
// This lets a Pi coding-agent session join the same mesh as Claude Code
// sessions. It forwards the mesh MCP tools to the hosted /api/mcp endpoint and
// opens the mesh SSE stream; incoming mesh messages are injected into the Pi
// conversation as <channel source="mesh"> messages that can wake the agent.
//
// Config resolution intentionally matches plugin/channel.mjs:
//   MESH_CODE or ~/.mesh/mcp.json Bearer token
//   MESH_URL  or ~/.mesh/mcp.json mcpServers.mesh.url (with /api/mcp stripped)
//   MESH_NAME optional auto-register identity
//   MESH_PARENT optional auto-register parent
//   MESH_HOST optional host label
//   MESH_AUTOWAKE=0 to receive messages without triggering an immediate turn

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";

type Json = Record<string, unknown>;
type RpcResponse = { result?: Json; error?: { message?: string; data?: unknown } };
type MeshTool = { name: string; description?: string; inputSchema?: Json };
type MeshMessage = { id?: number | string; sender: string; recipients?: string[]; content: string; ts?: string };

const DEFAULT_BASE = "https://mesh-production-d83a.up.railway.app";
const HOST = process.env.MESH_HOST || hostname();
const ENV_NAME = process.env.MESH_NAME || "";
const ENV_PARENT = process.env.MESH_PARENT || "";
const ENV_DESCRIPTION = process.env.MESH_DESCRIPTION || "Pi coding agent";
const HARNESS = process.env.MESH_HARNESS || "pi";
const HARNESS_VERSION = process.env.MESH_HARNESS_VERSION || process.env.PI_VERSION || "";
const MODEL_ENV = process.env.MESH_MODEL || process.env.PI_MODEL || process.env.OPENAI_MODEL || process.env.ANTHROPIC_MODEL || "";
const AUTOWAKE = process.env.MESH_AUTOWAKE !== "0";
const STATE_TYPE = "mesh-identity";

function stripApiMcp(url: string): string {
  return url.replace(/\/+$/, "").replace(/\/api\/mcp$/i, "");
}

function readConfig(): { code: string; base: string } {
  let code = process.env.MESH_CODE || "";
  let base = process.env.MESH_URL ? stripApiMcp(process.env.MESH_URL) : "";
  try {
    const cfg = JSON.parse(readFileSync(join(homedir(), ".mesh", "mcp.json"), "utf8"));
    const server = cfg?.mcpServers?.mesh ?? {};
    if (!code) code = String(server?.headers?.Authorization || cfg?.code || "").replace(/^Bearer\s+/i, "");
    if (!base) base = stripApiMcp(String(cfg?.url || server?.url || ""));
  } catch {
    // no shared config; env/defaults still apply
  }
  return { code, base: (base || DEFAULT_BASE).replace(/\/+$/, "") };
}

function recordName(name: string): void {
  try {
    const dir = join(homedir(), ".mesh", "run");
    mkdirSync(dir, { recursive: true });
    const h = createHash("sha1").update(process.cwd()).digest("hex").slice(0, 16);
    writeFileSync(join(dir, h + ".name"), name);
  } catch {
    // best effort only
  }
}

function textFromMcpResult(result: Json | undefined): string {
  const content = result?.content;
  if (!Array.isArray(content)) return "ok";
  return content
    .map((part: unknown) => {
      if (part && typeof part === "object" && (part as Json).type === "text") return String((part as Json).text ?? "");
      return "";
    })
    .filter(Boolean)
    .join("\n") || "ok";
}

function safeSchema(schema: unknown): Json {
  if (!schema || typeof schema !== "object") return { type: "object", properties: {}, required: [] };
  return schema as Json;
}

function xmlEscape(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c] || c));
}

function truncate(s: string, max = 6000): string {
  return s.length > max ? s.slice(0, max) + " […truncated]" : s;
}

function stringList(value: unknown, limit = 80): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && v.trim().length > 0).map((v) => v.trim()).slice(0, limit) : [];
}

function unique(values: string[], limit = 80): string[] {
  const out: string[] = [];
  for (const v of values) if (v && !out.includes(v)) out.push(v);
  return out.slice(0, limit);
}

function plainObject(value: unknown): Json {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {};
}

function modelLabel(model: unknown): string {
  if (MODEL_ENV) return MODEL_ENV;
  if (!model || typeof model !== "object") return "";
  const m = model as Json;
  const provider = typeof m.provider === "string" ? m.provider : "";
  const id = typeof m.id === "string" ? m.id : (typeof m.name === "string" ? m.name : "");
  return provider && id ? `${provider}/${id}` : (id || provider);
}

function callerNameFor(toolName: string, args: Json): string {
  switch (toolName) {
    case "register":
    case "heartbeat":
    case "set_status":
    case "set_capabilities":
    case "checkout":
    case "inbox":
    case "claim_task":
    case "update_task":
    case "claim_resource":
    case "release_resource":
      return typeof args.name === "string" ? args.name : "";
    case "send_message":
    case "wake":
      return typeof args.from === "string" ? args.from : "";
    case "create_task":
    case "create_artifact":
      return typeof args.creator === "string" ? args.creator : "";
    default:
      return "";
  }
}

export default function meshPiExtension(pi: any): void {
  const cfg = readConfig();
  const mcpUrl = `${cfg.base}/api/mcp`;
  const pollUrl = `${cfg.base}/api/mesh/poll`;
  const streamUrl = `${cfg.base}/api/mesh/stream`;
  const beatUrl = `${cfg.base}/api/mesh/beat`;

  let seq = 0;
  let instructions: string | null = null;
  let toolsRegistered = 0;
  let me = "";
  let leaving = false;
  let streamAbort: AbortController | null = null;
  let streaming = false;
  let primed = false;
  let lastId = 0;
  let latestModel = MODEL_ENV;
  let latestCtx: any = null;
  const seen = new Set<number>();
  const registeredToolNames = new Set<string>();

  async function httpRpc(method: string, params: Json = {}, tries = 3): Promise<RpcResponse> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < tries; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, 700 * attempt));
      try {
        const res = await fetch(mcpUrl, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${cfg.code}` },
          body: JSON.stringify({ jsonrpc: "2.0", id: ++seq, method, params }),
          signal: AbortSignal.timeout(12000),
        });
        return (await res.json()) as RpcResponse;
      } catch (e) {
        lastErr = e;
      }
    }
    return {
      error: {
        message: "mesh briefly unreachable — retry the same mesh call in a few seconds; stay on this mesh",
        data: String((lastErr as Error | undefined)?.message || lastErr),
      },
    };
  }

  function rememberIdentity(name: string): void {
    try {
      pi.appendEntry(STATE_TYPE, { name });
    } catch {
      // unavailable during teardown or before a session is bound
    }
  }

  function restoreIdentity(ctx: any): void {
    if (ENV_NAME || me) return;
    try {
      for (const entry of ctx.sessionManager?.getEntries?.() ?? []) {
        if (entry?.type === "custom" && entry?.customType === STATE_TYPE && typeof entry?.data?.name === "string") {
          me = entry.data.name;
        }
      }
    } catch {
      // no persisted identity
    }
  }

  async function meshTool(name: string, args: Json): Promise<string> {
    const j = await httpRpc("tools/call", { name, arguments: args });
    if (j.error) throw new Error(j.error.message || "mesh call failed");
    const isError = Boolean(j.result?.isError);
    const text = textFromMcpResult(j.result);
    if (isError) throw new Error(text);
    return text;
  }

  function activeToolNames(): string[] {
    try {
      const active = typeof pi.getActiveTools === "function" ? pi.getActiveTools() : [];
      if (Array.isArray(active) && active.length) return stringList(active, 80).sort();
    } catch {
      // fall through to all tools
    }
    try {
      const all = typeof pi.getAllTools === "function" ? pi.getAllTools() : [];
      if (Array.isArray(all)) return stringList(all.map((t: any) => t?.name), 80).sort();
    } catch {
      // no tool metadata available
    }
    return [];
  }

  function commandNames(): string[] {
    try {
      const cmds = typeof pi.getCommands === "function" ? pi.getCommands() : [];
      return Array.isArray(cmds) ? stringList(cmds.map((c: any) => c?.name), 80).sort() : [];
    } catch {
      return [];
    }
  }

  function detectedFeatures(tools: string[]): string[] {
    const has = (name: string) => tools.includes(name);
    const starts = (prefix: string) => tools.some((name) => name.startsWith(prefix));
    const out: string[] = [];
    if (has("bash")) out.push("shell");
    if (has("read")) out.push("file-read");
    if (has("edit") || has("write") || has("apply_patch")) out.push("file-edit");
    if (has("web_search") || has("web_fetch")) out.push("web");
    if (starts("browser_")) out.push("browser");
    if (has("background_bash") || has("tail_job") || has("stop_job")) out.push("background-jobs");
    if (has("update_plan")) out.push("planning");
    if (has("todo_read") || has("todo_write")) out.push("todos");
    out.push("live-push", "mesh-tools", "api-error-watchdog");
    return unique(out, 20);
  }

  function baseCapabilities(ctx?: any): Json {
    const tools = activeToolNames();
    const model = latestModel || modelLabel(ctx?.model);
    if (model) latestModel = model;
    return {
      bridge: "pi-extension",
      harness: HARNESS,
      harnessVersion: HARNESS_VERSION || undefined,
      model: model || undefined,
      livePush: true,
      apiErrorWatchdog: true,
      shell: tools.includes("bash"),
      fileRead: tools.includes("read"),
      fileEdit: tools.some((t) => ["edit", "write", "apply_patch"].includes(t)),
      web: tools.some((t) => ["web_search", "web_fetch"].includes(t)),
      browser: tools.some((t) => t.startsWith("browser_")),
      features: detectedFeatures(tools),
      tools,
      commands: commandNames(),
    };
  }

  function attachHarnessMetadata(args: Json, ctx?: any): void {
    if (!args.harness) args.harness = HARNESS;
    const model = latestModel || modelLabel(ctx?.model);
    if (model && !args.model) args.model = model;
    const base = baseCapabilities(ctx);
    const extra = plainObject(args.capabilities);
    args.capabilities = {
      ...base,
      ...extra,
      features: unique([...stringList(base.features), ...stringList(extra.features)], 40),
      tools: unique([...stringList(base.tools), ...stringList(extra.tools)], 80),
      commands: unique([...stringList(base.commands), ...stringList(extra.commands)], 80),
    };
  }

  async function publishCapabilities(): Promise<void> {
    if (!me || !cfg.code) return;
    const args: Json = { name: me };
    attachHarnessMetadata(args, latestCtx);
    try {
      await meshTool("set_capabilities", args);
    } catch {
      // Non-fatal: older server or transient network. Next register/status touch will retry.
    }
  }

  async function loadInstructions(): Promise<void> {
    if (!cfg.code) return;
    const j = await httpRpc("initialize", { protocolVersion: "2025-06-18" });
    if (!j.error && typeof j.result?.instructions === "string") instructions = j.result.instructions;
  }

  async function registerRemoteTools(): Promise<number> {
    if (!cfg.code) return 0;
    const j = await httpRpc("tools/list", {});
    if (j.error) throw new Error(j.error.message || "failed to list mesh tools");
    const tools = (Array.isArray(j.result?.tools) ? j.result?.tools : []) as MeshTool[];
    for (const tool of tools) {
      if (!tool?.name) continue;
      if (registeredToolNames.has(tool.name)) continue;
      registeredToolNames.add(tool.name);
      pi.registerTool({
        name: tool.name,
        label: `mesh ${tool.name}`,
        description: tool.description || `mesh tool: ${tool.name}`,
        promptSnippet: truncate(tool.description || `mesh tool: ${tool.name}`, 220),
        parameters: safeSchema(tool.inputSchema),
        prepareArguments(args: unknown) {
          return args && typeof args === "object" ? args : {};
        },
        async execute(_toolCallId: string, params: Json) {
          const args: Json = { ...(params || {}) };

          // Match the Claude Code channel plugin: if MESH_NAME is set, it is the
          // authoritative peer name and registration is pinned to it.
          if (tool.name === "register") {
            if (ENV_NAME) args.name = ENV_NAME;
            if (!args.host) args.host = HOST;
          }
          if (tool.name === "register" || tool.name === "set_capabilities") attachHarnessMetadata(args, latestCtx);

          const text = await meshTool(tool.name, args);

          // Learn identity only from arguments that represent the CALLER. Some
          // mesh tools use `name` for a target peer (set_parent/deregister), so
          // don't blindly adopt every name-shaped argument.
          const learned = callerNameFor(tool.name, args);
          if (tool.name === "checkout") {
            if (!me || learned === me) {
              stopStream();
              me = "";
              rememberIdentity("");
            }
          } else if (learned) {
            me = learned;
            rememberIdentity(me);
            recordName(me);
            pi.setSessionName?.(`mesh:${me}`);
            startStream();
          }
          return { content: [{ type: "text", text }], details: { meshTool: tool.name } };
        },
      });
    }
    toolsRegistered = registeredToolNames.size;
    return toolsRegistered;
  }

  async function catchUp(): Promise<void> {
    if (!me || !cfg.code) return;
    try {
      const res = await fetch(`${pollUrl}?name=${encodeURIComponent(me)}&since=${lastId}`, {
        headers: { authorization: `Bearer ${cfg.code}` },
        signal: AbortSignal.timeout(12000),
      });
      if (!res.ok) return;
      const data = (await res.json()) as { messages?: MeshMessage[]; cursor?: number };
      if (!primed) {
        primed = true;
        if (typeof data.cursor === "number") lastId = data.cursor;
        return;
      }
      for (const m of data.messages ?? []) deliver(m);
      if (typeof data.cursor === "number") lastId = Math.max(lastId, data.cursor);
    } catch {
      // stream reconnect will try again
    }
  }

  function deliver(m: MeshMessage): void {
    const mid = Number(m.id || 0);
    if (mid) {
      if (seen.has(mid)) return;
      seen.add(mid);
      if (seen.size > 1000) seen.delete(seen.values().next().value as number);
      lastId = Math.max(lastId, mid);
    }
    const recipients = m.recipients ?? [];
    const kind = recipients.length ? "direct" : "broadcast";
    const to = recipients.length ? ` to=\"${xmlEscape(recipients.join(","))}\"` : "";
    const body = `${m.sender}: ${m.content}`;
    try {
      pi.sendMessage(
        {
          customType: "mesh-channel",
          content: `<channel source=\"mesh\" from=\"${xmlEscape(m.sender)}\" kind=\"${kind}\"${to}>\n${xmlEscape(body)}\n</channel>`,
          display: true,
          details: m,
        },
        { triggerTurn: AUTOWAKE, deliverAs: "followUp" },
      );
    } catch {
      // stale runtime during shutdown/reload
    }
  }

  function stopStream(): void {
    streamAbort?.abort();
    streamAbort = null;
    streaming = false;
    primed = false;
  }

  async function streamLoop(signal: AbortSignal): Promise<void> {
    if (streaming) return;
    streaming = true;
    while (!leaving && me && cfg.code && !signal.aborted) {
      try {
        await catchUp();
        const res = await fetch(`${streamUrl}?name=${encodeURIComponent(me)}`, {
          headers: { authorization: `Bearer ${cfg.code}`, accept: "text/event-stream" },
          signal,
        });
        if (!res.ok || !res.body) {
          await new Promise((r) => setTimeout(r, 2000));
          continue;
        }
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        while (!leaving && !signal.aborted) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let nl = buf.indexOf("\n");
          while (nl >= 0) {
            const line = buf.slice(0, nl).trimEnd();
            buf = buf.slice(nl + 1);
            if (line.startsWith("data:")) {
              try {
                deliver(JSON.parse(line.slice(5).trim()) as MeshMessage);
              } catch {
                // ignore malformed/event comments
              }
            }
            nl = buf.indexOf("\n");
          }
        }
      } catch {
        // dropped connection; reconnect below
      }
      if (!leaving && !signal.aborted) await new Promise((r) => setTimeout(r, 1500));
    }
    streaming = false;
  }

  function startStream(): void {
    if (!me || !cfg.code || streamAbort) return;
    streamAbort = new AbortController();
    pi.setSessionName?.(`mesh:${me}`);
    void streamLoop(streamAbort.signal);
  }

  async function beat(event: "stop" | "idle"): Promise<void> {
    if (!me || !cfg.code) return;
    try {
      await fetch(beatUrl, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${cfg.code}` },
        body: JSON.stringify({ name: me, event }),
        signal: AbortSignal.timeout(6000),
      });
    } catch {
      // best effort only
    }
  }

  async function autoRegister(): Promise<string | null> {
    if (!ENV_NAME || !cfg.code) return null;
    const args: Json = { name: ENV_NAME, description: ENV_DESCRIPTION, host: HOST };
    if (ENV_PARENT) args.parent = ENV_PARENT;
    attachHarnessMetadata(args, latestCtx);
    const text = await meshTool("register", args);
    me = ENV_NAME;
    rememberIdentity(me);
    recordName(me);
    pi.setSessionName?.(`mesh:${me}`);
    startStream();
    return text;
  }

  pi.on("session_start", async (_event: unknown, ctx: any) => {
    leaving = false;
    latestCtx = ctx;
    latestModel = modelLabel(ctx?.model) || latestModel;
    restoreIdentity(ctx);
    if (!cfg.code) {
      ctx.ui?.notify?.("mesh: no MESH_CODE / ~/.mesh/mcp.json; bridge inactive", "warning");
      return;
    }
    try {
      await loadInstructions();
      const count = await registerRemoteTools();
      if (me) {
        startStream();
        void publishCapabilities();
      }
      ctx.ui?.setStatus?.("mesh", me ? `mesh:${me}` : "mesh ready");
      if (ENV_NAME) {
        await autoRegister();
        ctx.ui?.setStatus?.("mesh", `mesh:${ENV_NAME}`);
        ctx.ui?.notify?.(`mesh: registered ${ENV_NAME} (${count} tools)`, "info");
      } else {
        ctx.ui?.notify?.(`mesh: ${count} tools loaded; call register or /mesh-register to join`, "info");
      }
    } catch (e) {
      ctx.ui?.notify?.(`mesh bridge failed: ${(e as Error).message}`, "error");
    }
  });

  pi.on("model_select", async (event: any, ctx: any) => {
    latestCtx = ctx;
    latestModel = modelLabel(event?.model) || latestModel;
    void publishCapabilities();
  });

  pi.on("before_agent_start", async (event: any) => {
    if (!instructions) return;
    const identity = me || ENV_NAME;
    const preface =
      "PI MESH BRIDGE: You are connected to mesh through a Pi extension. " +
      "Incoming mesh messages arrive as literal <channel source=\"mesh\"> messages injected into this session. " +
      "Use the mesh tools exposed in this session (register, send_message, list_tasks, etc.). " +
      (identity ? `Your mesh name is ${identity}; keep using that exact name.\n\n` : "Register once with your assigned mesh name before coordinating.\n\n");
    return { systemPrompt: `${event.systemPrompt}\n\n${preface}${instructions}` };
  });

  pi.on("turn_end", async () => {
    void beat("stop");
  });

  pi.on("session_shutdown", async (event: any) => {
    leaving = true;
    stopStream();
    if (event?.reason === "reload") return;
    if (me && cfg.code) {
      const oldName = me;
      me = "";
      rememberIdentity("");
      try {
        await Promise.race([
          meshTool("checkout", { name: oldName }),
          new Promise((r) => setTimeout(r, 2000)),
        ]);
      } catch {
        // reaper is the backstop
      }
    }
  });

  pi.registerCommand("mesh-register", {
    description: "Join mesh from Pi: /mesh-register <name> [parent]",
    handler: async (args: string, ctx: any) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const name = ENV_NAME || parts[0];
      const parent = ENV_NAME ? (parts[0] || ENV_PARENT) : (parts[1] || ENV_PARENT);
      if (!name) return ctx.ui?.notify?.("Usage: /mesh-register <name> [parent] (or launch with MESH_NAME)", "warning");
      try {
        if (!toolsRegistered) await registerRemoteTools();
        const reg: Json = { name, description: ENV_DESCRIPTION, host: HOST };
        if (parent) reg.parent = parent;
        attachHarnessMetadata(reg, ctx);
        const text = await meshTool("register", reg);
        me = name;
        rememberIdentity(me);
        recordName(me);
        pi.setSessionName?.(`mesh:${me}`);
        startStream();
        ctx.ui?.setStatus?.("mesh", `mesh:${me}`);
        ctx.ui?.notify?.(text, "info");
      } catch (e) {
        ctx.ui?.notify?.(`mesh-register failed: ${(e as Error).message}`, "error");
      }
    },
  });

  pi.registerCommand("mesh-send", {
    description: "Send a mesh message: /mesh-send <peer|all> <message>",
    handler: async (args: string, ctx: any) => {
      if (!me) return ctx.ui?.notify?.("Register first: /mesh-register <name>", "warning");
      const m = /^(\S+)\s+([\s\S]+)$/.exec(args.trim());
      if (!m) return ctx.ui?.notify?.("Usage: /mesh-send <peer|all> <message>", "warning");
      const to = m[1] === "all" ? [] : m[1].split(",").filter(Boolean);
      try {
        const text = await meshTool("send_message", { from: me, to, content: m[2] });
        ctx.ui?.notify?.(text, "info");
      } catch (e) {
        ctx.ui?.notify?.(`mesh-send failed: ${(e as Error).message}`, "error");
      }
    },
  });

  pi.registerCommand("mesh-checkout", {
    description: "Leave mesh for this Pi session",
    handler: async (_args: string, ctx: any) => {
      if (!me) return ctx.ui?.notify?.("mesh: not registered", "info");
      try {
        const old = me;
        await meshTool("checkout", { name: old });
        stopStream();
        me = "";
        rememberIdentity("");
        pi.setSessionName?.("mesh:checked-out");
        ctx.ui?.setStatus?.("mesh", undefined);
        ctx.ui?.notify?.(`mesh: ${old} checked out`, "info");
      } catch (e) {
        ctx.ui?.notify?.(`mesh-checkout failed: ${(e as Error).message}`, "error");
      }
    },
  });

  pi.registerCommand("mesh-status", {
    description: "Show Pi mesh bridge status",
    handler: async (_args: string, ctx: any) => {
      ctx.ui?.notify?.(
        `mesh ${cfg.code ? "configured" : "missing-code"} ${me ? `as ${me}` : "not registered"} @ ${cfg.base} · ${toolsRegistered} tools · stream ${streamAbort ? "on" : "off"}`,
        cfg.code ? "info" : "warning",
      );
    },
  });

  pi.registerCommand("mesh-reload", {
    description: "Reload remote mesh instructions/tools",
    handler: async (_args: string, ctx: any) => {
      try {
        await loadInstructions();
        const count = await registerRemoteTools();
        ctx.ui?.notify?.(`mesh: reloaded ${count} tools`, "info");
      } catch (e) {
        ctx.ui?.notify?.(`mesh-reload failed: ${(e as Error).message}`, "error");
      }
    },
  });
}
