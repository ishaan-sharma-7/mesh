// Liveness beats from the Claude Code Stop / StopFailure hooks (see plugin/hooks).
// The hook is a plain shell command that fires at every turn end, so it reports an
// agent's health from OUTSIDE the model — an agent killed by an API error can't
// report its own failure, but the hook still fires. Bearer-gated with the mesh code.
//
//   POST { name, event: "stop" | "error" | "idle", error_type? }
//     stop  -> healthy turn completed (clears any error streak)
//     error -> StopFailure: a turn aborted on an API error (error_type carries the kind)
//     idle  -> parked waiting for input (proof of life only)

import { NextRequest, NextResponse } from "next/server";
import { bearerOk } from "@/lib/auth";
import { recordBeat, MeshError } from "@/lib/mesh";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  if (!bearerOk(req.headers.get("authorization"))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  let body: { name?: string; event?: string; error_type?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  if (!body.name || !body.event) return NextResponse.json({ error: "name and event required" }, { status: 400 });
  try {
    const r = await recordBeat({ name: body.name, event: body.event, error_type: body.error_type });
    return NextResponse.json(r);
  } catch (e) {
    const status = e instanceof MeshError ? 400 : 500;
    return NextResponse.json({ error: (e as Error).message }, { status });
  }
}
