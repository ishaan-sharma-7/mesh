// The channel polls this for new messages addressed to a peer (and broadcasts),
// excluding the peer's own messages. Reading also bumps last_seen, so polling
// doubles as the peer's heartbeat. Bearer-gated with the shared mesh code.

import { NextRequest, NextResponse } from "next/server";
import { bearerOk } from "@/lib/auth";
import { inbox, MeshError } from "@/lib/mesh";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (!bearerOk(req.headers.get("authorization"))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const name = req.nextUrl.searchParams.get("name");
  const since = Number(req.nextUrl.searchParams.get("since") || 0) || undefined;
  if (!name) return NextResponse.json({ error: "name required" }, { status: 400 });
  try {
    const r = await inbox(name, since);
    return NextResponse.json(r);
  } catch (e) {
    const status = e instanceof MeshError ? 400 : 500;
    return NextResponse.json({ error: (e as Error).message }, { status });
  }
}
