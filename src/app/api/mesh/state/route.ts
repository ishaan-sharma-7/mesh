// Live snapshot for the website: peers, tasks, recent messages. The dashboard
// polls this. Gated by the mesh-code cookie.

import { NextRequest, NextResponse } from "next/server";
import { codeOk, COOKIE } from "@/lib/auth";
import { getState } from "@/lib/mesh";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (!codeOk(req.cookies.get(COOKIE)?.value)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const state = await getState();
  return NextResponse.json(state);
}
