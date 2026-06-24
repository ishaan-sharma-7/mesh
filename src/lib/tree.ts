// Text renderers for the MCP responses — agents read these as plain trees.

import type { Peer, Task } from "./mesh";

function peerMeta(p: Peer): string {
  const bits: string[] = [];
  if (p.host) bits.push(`@${p.host}`);
  if (p.harness) bits.push(p.harness);
  if (p.model) bits.push(p.model);
  return bits.length ? ` [${bits.join(" · ")}]` : "";
}

export function renderPeerTree(peers: Peer[]): string {
  const byName = new Map(peers.map((p) => [p.name, p]));
  const children = new Map<string, Peer[]>();
  const roots: Peer[] = [];
  for (const p of peers) {
    if (p.parent && byName.has(p.parent)) {
      (children.get(p.parent) ?? children.set(p.parent, []).get(p.parent)!).push(p);
    } else roots.push(p);
  }
  const label = (p: Peer) => {
    const meta = peerMeta(p);
    if (!p.online) return `${p.name}${meta} (offline)`;
    // Liveness first: an agent killed by an API error (or silently stalled) is the
    // most important thing a leader needs to see — it can't report this itself.
    if (p.health === "api_error") {
      const since = p.error_since ? ` ${Math.round((Date.now() - new Date(p.error_since).getTime()) / 60000)}m` : "";
      return `${p.name}${meta} ⚠ DOWN — API ERROR (${p.api_error ?? "unknown"})${since} — parked, mesh auto-retrying. Reassign its work if urgent.`;
    }
    if (p.health === "stalled") {
      return `${p.name}${meta} ⚠ STALLED — went silent with work in hand (possible API error). Check on it / reassign.`;
    }
    const st = p.effective_status ?? p.status; // honest, activity-derived
    let blocked = "";
    if (st === "blocked") {
      const since = p.blocked_since ? ` ${Math.round((Date.now() - new Date(p.blocked_since).getTime()) / 60000)}m` : "";
      blocked = ` [blocked${since}${p.blocked_reason ? `: ${p.blocked_reason}` : ""}]`;
    }
    return `${p.name}${meta} (${st})${blocked}${p.current_task && st !== "blocked" ? ` — ${p.current_task}` : ""}`;
  };
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
  // Promote orphans (a task whose parent was filtered out, e.g. a done parent) to
  // the root so they still render instead of vanishing.
  const nums = new Set(tasks.map((t) => t.num));
  const children = new Map<number | null, Task[]>();
  for (const t of tasks) {
    const key = t.parent_num != null && nums.has(t.parent_num) ? t.parent_num : null;
    (children.get(key) ?? children.set(key, []).get(key)!).push(t);
  }
  const mark: Record<string, string> = { backlog: "○", design: "✎", in_progress: "◐", blocked: "⊘", done: "●" };
  const label = (t: Task) => {
    // `gating` is the blockers that aren't done yet (computed server-side).
    const waiting = t.gating ?? [];
    const gate = waiting.length ? ` ⛔ needs ${waiting.map((n) => `#${n}`).join(", ")}` : "";
    const design = t.status === "design" ? " [design — not buildable until locked]" : "";
    const base = t.base ? ` (base: ${t.base})` : "";
    // for done tasks, show the result — this is the record of what's already built
    const result = t.status === "done" && t.result ? ` :: ${t.result.length > 100 ? t.result.slice(0, 100) + "…" : t.result}` : "";
    return `${mark[t.status] ?? "○"} #${t.num} ${t.title}${t.assignee ? ` @${t.assignee}` : ""}${t.status === "blocked" ? " [blocked]" : ""}${design}${base}${gate}${result}`;
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
