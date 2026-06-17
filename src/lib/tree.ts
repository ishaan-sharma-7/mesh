// Text renderers for the MCP responses — agents read these as plain trees.

import type { Peer, Task } from "./mesh";

export function renderPeerTree(peers: Peer[]): string {
  const byName = new Map(peers.map((p) => [p.name, p]));
  const children = new Map<string, Peer[]>();
  const roots: Peer[] = [];
  for (const p of peers) {
    if (p.parent && byName.has(p.parent)) {
      (children.get(p.parent) ?? children.set(p.parent, []).get(p.parent)!).push(p);
    } else roots.push(p);
  }
  const label = (p: Peer) =>
    `${p.name} (${p.online ? p.status : "offline"})${p.current_task ? ` — ${p.current_task}` : ""}`;
  const lines: string[] = [];
  const walk = (p: Peer, prefix: string, last: boolean, depth: number) => {
    lines.push(depth === 0 ? label(p) : `${prefix}${last ? "└─ " : "├─ "}${label(p)}`);
    const kids = (children.get(p.name) ?? []).sort((a, b) => a.name.localeCompare(b.name));
    const np = depth === 0 ? "" : prefix + (last ? "   " : "│  ");
    kids.forEach((k, i) => walk(k, np, i === kids.length - 1, depth + 1));
  };
  roots.sort((a, b) => a.name.localeCompare(b.name)).forEach((r) => walk(r, "", true, 0));
  return lines.join("\n") || "(no peers)";
}

export function renderTaskTree(tasks: Task[]): string {
  const children = new Map<number | null, Task[]>();
  for (const t of tasks) {
    const key = t.parent_num;
    (children.get(key) ?? children.set(key, []).get(key)!).push(t);
  }
  const mark: Record<string, string> = { backlog: "○", in_progress: "◐", blocked: "⊘", done: "●" };
  const label = (t: Task) => {
    // `gating` is the blockers that aren't done yet (computed server-side).
    const waiting = t.gating ?? [];
    const gate = waiting.length ? ` ⛔ blocked by ${waiting.map((n) => `#${n}`).join(", ")}` : "";
    return `${mark[t.status] ?? "○"} #${t.num} ${t.title}${t.assignee ? ` @${t.assignee}` : ""}${t.status === "blocked" ? " [blocked]" : ""}${gate}`;
  };
  const lines: string[] = [];
  const walk = (t: Task, prefix: string, last: boolean, depth: number) => {
    lines.push(depth === 0 ? label(t) : `${prefix}${last ? "└─ " : "├─ "}${label(t)}`);
    const kids = (children.get(t.num) ?? []).sort((a, b) => a.num - b.num);
    const np = depth === 0 ? "" : prefix + (last ? "   " : "│  ");
    kids.forEach((k, i) => walk(k, np, i === kids.length - 1, depth + 1));
  };
  (children.get(null) ?? []).sort((a, b) => a.num - b.num).forEach((r, i, arr) => walk(r, "", i === arr.length - 1, 0));
  return lines.join("\n") || "(no tasks)";
}
