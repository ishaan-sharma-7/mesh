// Task control from the website: create, delete, re-parent, assign, set status.
// Gated by the mesh-code cookie. Thin wrapper over the same mesh ops the agents use.

import { NextRequest, NextResponse } from "next/server";
import { codeOk, COOKIE } from "@/lib/auth";
import * as mesh from "@/lib/mesh";
import { MeshError } from "@/lib/mesh";
import { notifyChange } from "@/lib/bus";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Body =
  | { action: "createTask"; title: string; detail?: string; parentNum?: number | null; assignee?: string }
  | { action: "deleteTask"; num: number }
  | { action: "setTaskParent"; num: number; parentNum: number | null }
  | { action: "assignTask"; num: number; assignee: string }
  | { action: "updateTask"; num: number; status: string; result?: string }
  | { action: "addBlocker"; num: number; by: number }
  | { action: "removeBlocker"; num: number; by: number }
  | { action: "checkout"; name: string };

export async function POST(req: NextRequest) {
  if (!codeOk(req.cookies.get(COOKIE)?.value)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const b = (await req.json().catch(() => null)) as Body | null;
  if (!b || !b.action) return NextResponse.json({ error: "missing action" }, { status: 400 });
  try {
    let data: unknown;
    switch (b.action) {
      case "createTask":
        data = await mesh.createTask({ title: b.title, detail: b.detail, parentNum: b.parentNum, assignee: b.assignee, creator: "web" });
        break;
      case "deleteTask":
        data = await mesh.deleteTask(b.num);
        break;
      case "setTaskParent":
        data = await mesh.setTaskParent(b.num, b.parentNum);
        break;
      case "assignTask":
        data = await mesh.assignTask(b.num, b.assignee);
        break;
      case "updateTask":
        data = await mesh.updateTask(b.num, b.status, b.result);
        break;
      case "addBlocker":
        data = await mesh.addBlocker(b.num, b.by);
        break;
      case "removeBlocker":
        data = await mesh.removeBlocker(b.num, b.by);
        break;
      case "checkout":
        data = await mesh.checkout(b.name);
        break;
      default:
        return NextResponse.json({ error: "unknown action" }, { status: 400 });
    }
    void notifyChange(); // wake any open dashboard stream
    return NextResponse.json({ ok: true, data });
  } catch (e) {
    const status = e instanceof MeshError ? 400 : 500;
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status });
  }
}
