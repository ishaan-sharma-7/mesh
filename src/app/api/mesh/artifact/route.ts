// Full artifact body, on demand. The state snapshot only carries artifact
// metadata (handle/kind/title) so the frequent poll stays cheap; the dashboard
// calls this when you open one to render its markdown content. Same mesh-code gate.

import { NextRequest, NextResponse } from "next/server";
import { codeOk, COOKIE } from "@/lib/auth";
import { getArtifact, deleteArtifact } from "@/lib/mesh";
import { MeshError } from "@/lib/mesh";
import { notifyChange } from "@/lib/bus";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (!codeOk(req.cookies.get(COOKIE)?.value)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const handle = req.nextUrl.searchParams.get("handle");
  if (!handle) return NextResponse.json({ error: "handle is required" }, { status: 400 });
  try {
    const { artifact } = await getArtifact(handle);
    return NextResponse.json({ artifact });
  } catch (e) {
    const msg = e instanceof MeshError ? e.message : "lookup failed";
    return NextResponse.json({ error: msg }, { status: 404 });
  }
}

// Remove an artifact from the dashboard (same mesh-code gate). Mirrors the
// delete_artifact MCP tool, so a watcher can prune obsolete docs by hand.
export async function DELETE(req: NextRequest) {
  if (!codeOk(req.cookies.get(COOKIE)?.value)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const handle = req.nextUrl.searchParams.get("handle");
  if (!handle) return NextResponse.json({ error: "handle is required" }, { status: 400 });
  try {
    const { removed } = await deleteArtifact(handle);
    void notifyChange(); // wake any open dashboard stream
    return NextResponse.json({ ok: true, removed });
  } catch (e) {
    const msg = e instanceof MeshError ? e.message : "delete failed";
    return NextResponse.json({ error: msg }, { status: 404 });
  }
}
