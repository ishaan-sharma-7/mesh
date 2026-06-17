// The MCP endpoint Claude agents connect to. Speaks JSON-RPC over HTTP
// (the MCP "Streamable HTTP" transport), stateless. Auth is the shared mesh
// code as a Bearer token.

import { NextRequest, NextResponse } from "next/server";
import { bearerOk } from "@/lib/auth";
import { MeshError, maybeReap } from "@/lib/mesh";
import { TOOLS, TOOLS_BY_NAME } from "@/lib/tools";
import { MESH_INSTRUCTIONS } from "@/lib/protocol";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PROTOCOL = "2025-06-18";
const SERVER = { name: "mesh", version: "0.1.0" };

type RpcReq = { jsonrpc: "2.0"; id?: string | number | null; method: string; params?: Record<string, unknown> };

function result(id: RpcReq["id"], res: unknown) {
  return { jsonrpc: "2.0" as const, id, result: res };
}
function error(id: RpcReq["id"], code: number, message: string) {
  return { jsonrpc: "2.0" as const, id, error: { code, message } };
}

async function handle(msg: RpcReq): Promise<object | null> {
  // Notifications (no id) get no response.
  if (msg.id === undefined || msg.id === null) {
    return null;
  }
  switch (msg.method) {
    case "initialize":
      return result(msg.id, {
        protocolVersion: (msg.params?.protocolVersion as string) || PROTOCOL,
        capabilities: { tools: {} },
        serverInfo: SERVER,
        instructions: MESH_INSTRUCTIONS,
      });
    case "ping":
      return result(msg.id, {});
    case "tools/list":
      return result(msg.id, { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    case "tools/call": {
      const name = msg.params?.name as string;
      const args = (msg.params?.arguments as Record<string, unknown>) ?? {};
      const tool = TOOLS_BY_NAME.get(name);
      if (!tool) return result(msg.id, { content: [{ type: "text", text: `unknown tool: ${name}` }], isError: true });
      try {
        const text = await tool.run(args);
        return result(msg.id, { content: [{ type: "text", text }] });
      } catch (e) {
        const text = e instanceof MeshError ? e.message : `error: ${(e as Error).message}`;
        return result(msg.id, { content: [{ type: "text", text }], isError: true });
      }
    }
    default:
      return error(msg.id, -32601, `method not found: ${msg.method}`);
  }
}

export async function POST(req: NextRequest) {
  if (!bearerOk(req.headers.get("authorization"))) {
    return NextResponse.json(error(null, -32001, "invalid or missing mesh code"), {
      status: 401,
      headers: { "WWW-Authenticate": 'Bearer realm="mesh"' },
    });
  }
  void maybeReap(); // self-clean on agent activity (throttled), don't block the response
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(error(null, -32700, "parse error"), { status: 400 });
  }

  if (Array.isArray(body)) {
    const out = (await Promise.all(body.map((m) => handle(m as RpcReq)))).filter(Boolean);
    return out.length ? NextResponse.json(out) : new NextResponse(null, { status: 202 });
  }
  const res = await handle(body as RpcReq);
  return res ? NextResponse.json(res) : new NextResponse(null, { status: 202 });
}

// This server doesn't push server-initiated events, so there's no GET stream.
export async function GET() {
  return new NextResponse("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
}
