"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type Peer = {
  name: string; description: string | null; parent: string | null;
  status: string; current_task: string | null; online: boolean;
};
type Task = {
  num: number; title: string; detail: string | null; parent_num: number | null;
  status: string; assignee: string | null; creator: string | null; result: string | null;
  blocked_by?: number[];
};
type Message = { id: number; sender: string; recipients: string[]; content: string; ts: string };
type State = { peers: Peer[]; tasks: Task[]; messages: Message[] };

const MARK: Record<string, string> = { backlog: "○", in_progress: "◐", blocked: "⊘", done: "●" };
const NEXT: Record<string, string> = { backlog: "in_progress", in_progress: "done", done: "backlog", blocked: "in_progress" };

export default function Dashboard() {
  const [state, setState] = useState<State | null>(null);
  const [title, setTitle] = useState("");
  const [parent, setParent] = useState<string>("");
  const titleRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    const res = await fetch("/api/mesh/state", { cache: "no-store" });
    if (res.status === 401) { window.location.reload(); return; }
    if (res.ok) setState(await res.json());
  }, []);

  useEffect(() => {
    load();
    const id = setInterval(load, 2000);
    return () => clearInterval(id);
  }, [load]);

  async function act(body: object) {
    await fetch("/api/mesh/action", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    load();
  }

  async function addTask(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    await act({ action: "createTask", title: title.trim(), parentNum: parent ? Number(parent) : null });
    setTitle("");
    setParent("");
  }

  async function logout() {
    await fetch("/api/auth", { method: "DELETE" });
    window.location.reload();
  }

  const peers = state?.peers ?? [];
  const tasks = state?.tasks ?? [];
  const messages = state?.messages ?? [];
  const online = peers.filter((p) => p.online).length;

  return (
    <>
      <header className="bar">
        <span className="brand">mesh</span>
        <span className="stat">{online} online · {peers.length} peers · {tasks.filter((t) => t.status !== "done").length} open tasks</span>
        <span className="spacer" />
        <button className="ghost" onClick={logout}>log out</button>
      </header>

      <div className="grid">
        {/* peers — who's here and what they're working on */}
        <section className="panel">
          <h2>Mesh</h2>
          <div className="body">
            {peers.length === 0 ? <div className="empty">No peers yet. Connect an agent and it&apos;ll appear here.</div> : (
              <PeerTree peers={peers} tasks={tasks}
                onRemove={(name) => { if (confirm(`Remove ${name} from the mesh? Any task it's on goes back to the backlog.`)) act({ action: "checkout", name }); }}
              />
            )}
          </div>
        </section>

        {/* tasks */}
        <section className="panel">
          <h2>Tasks</h2>
          <form className="newtask" onSubmit={addTask}>
            <input ref={titleRef} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="new task…" />
            <select value={parent} onChange={(e) => setParent(e.target.value)}>
              <option value="">top level</option>
              {tasks.map((t) => <option key={t.num} value={t.num}>under #{t.num} {t.title.slice(0, 24)}</option>)}
            </select>
            <button className="primary" type="submit">Add</button>
          </form>
          <div className="body">
            {tasks.length === 0 ? <div className="empty">No tasks yet.</div> : (
              <TaskTree tasks={tasks} peers={peers}
                onStatus={(num, status) => act({ action: "updateTask", num, status })}
                onDelete={(num) => { if (confirm(`Delete task #${num} (and any subtasks)?`)) act({ action: "deleteTask", num }); }}
                onParent={(num, parentNum) => act({ action: "setTaskParent", num, parentNum })}
                onAssign={(num, assignee) => act({ action: assignee ? "assignTask" : "updateTask", num, assignee, status: "backlog" })}
                onSub={(num) => { setParent(String(num)); titleRef.current?.focus(); }}
                onAddBlocker={(num, by) => act({ action: "addBlocker", num, by })}
                onRemoveBlocker={(num, by) => act({ action: "removeBlocker", num, by })}
              />
            )}
          </div>
        </section>

        {/* messages */}
        <section className="panel">
          <h2>Feed</h2>
          <div className="body">
            {messages.length === 0 ? <div className="empty">No messages yet.</div> :
              messages.map((m) => (
                <div className="msg" key={m.id}>
                  <span className="time">{new Date(m.ts).toLocaleTimeString()}</span>
                  <span className="from">{m.sender}{m.recipients.length ? ` → ${m.recipients.join(", ")}` : ""}</span>
                  <div>{m.content}</div>
                </div>
              ))}
          </div>
        </section>
      </div>
    </>
  );
}

function PeerTree({ peers, tasks, onRemove }: { peers: Peer[]; tasks: Task[]; onRemove: (name: string) => void }) {
  const byName = new Map(peers.map((p) => [p.name, p]));
  const children = new Map<string | null, Peer[]>();
  for (const p of peers) {
    const key = p.parent && byName.has(p.parent) ? p.parent : null;
    (children.get(key) ?? children.set(key, []).get(key)!).push(p);
  }
  // what each agent is actively working on
  const activeByPeer = new Map<string, Task[]>();
  for (const t of tasks) {
    if (t.assignee && t.status === "in_progress") (activeByPeer.get(t.assignee) ?? activeByPeer.set(t.assignee, []).get(t.assignee)!).push(t);
  }
  const render = (parent: string | null, depth: number): React.ReactNode =>
    (children.get(parent) ?? []).sort((a, b) => a.name.localeCompare(b.name)).map((p) => {
      const doing = activeByPeer.get(p.name) ?? [];
      return (
        <div key={p.name}>
          <div className={`peer ${p.online ? "" : "offline"}`} style={{ paddingLeft: depth * 16 }}>
            <span className={`dot ${p.online ? "on" : "off"}`} />
            {p.name}
            <span className="meta"> · {p.online ? p.status : "offline"}</span>
            <button className="ghost danger peer-x" title="remove from mesh" onClick={() => onRemove(p.name)}>×</button>
          </div>
          {doing.map((t) => (
            <div key={t.num} className="doing" style={{ paddingLeft: depth * 16 + 18 }}>↳ working on #{t.num} {t.title}</div>
          ))}
          {render(p.name, depth + 1)}
        </div>
      );
    });
  return <>{render(null, 0)}</>;
}

function TaskTree({ tasks, peers, onStatus, onDelete, onParent, onAssign, onSub, onAddBlocker, onRemoveBlocker }: {
  tasks: Task[]; peers: Peer[];
  onStatus: (num: number, status: string) => void;
  onDelete: (num: number) => void;
  onParent: (num: number, parentNum: number | null) => void;
  onAssign: (num: number, assignee: string) => void;
  onSub: (num: number) => void;
  onAddBlocker: (num: number, by: number) => void;
  onRemoveBlocker: (num: number, by: number) => void;
}) {
  const children = new Map<number | null, Task[]>();
  const statusByNum = new Map<number, string>();
  const titleByNum = new Map<number, string>();
  for (const t of tasks) { statusByNum.set(t.num, t.status); titleByNum.set(t.num, t.title); }
  for (const t of tasks) (children.get(t.parent_num) ?? children.set(t.parent_num, []).get(t.parent_num)!).push(t);
  const onlineByPeer = new Map(peers.map((p) => [p.name, p.online]));

  const render = (parent: number | null, depth: number): React.ReactNode =>
    (children.get(parent) ?? []).sort((a, b) => a.num - b.num).map((t) => {
      const blockers = t.blocked_by ?? [];
      const waiting = blockers.filter((n) => statusByNum.get(n) !== "done");
      const gated = waiting.length > 0 && t.status !== "done";
      return (
        <div key={t.num}>
          <div className={`task ${gated ? "gated" : ""}`} style={{ paddingLeft: depth * 18 }}>
            <span className={`mark s-${t.status}`} title={t.status} onClick={() => onStatus(t.num, NEXT[t.status])} style={{ cursor: "pointer" }}>{MARK[t.status]}</span>
            <span className="num">#{t.num}</span>
            <span className={`title ${t.status === "done" ? "done" : ""}`}>{t.title}</span>
            {t.assignee && <span className="who"><span className={`dot ${onlineByPeer.get(t.assignee) ? "on" : "off"}`} />@{t.assignee}</span>}
            {blockers.map((n) => (
              <span key={n} className={`chip ${statusByNum.get(n) === "done" ? "done" : "block"}`} title={titleByNum.get(n)}>
                ⛔ #{n}<button className="x" onClick={() => onRemoveBlocker(t.num, n)} title="remove">×</button>
              </span>
            ))}
            <span className="actions">
              <select className="ghost" value={t.assignee ?? ""} onChange={(e) => onAssign(t.num, e.target.value)} title="assign">
                <option value="">unassigned</option>
                {peers.map((p) => <option key={p.name} value={p.name}>@{p.name}</option>)}
              </select>
              <select className="ghost" value="" onChange={(e) => { if (e.target.value) onAddBlocker(t.num, Number(e.target.value)); }} title="block on another task">
                <option value="">block on…</option>
                {tasks.filter((o) => o.num !== t.num && !blockers.includes(o.num)).map((o) => <option key={o.num} value={o.num}>#{o.num} {o.title.slice(0, 20)}</option>)}
              </select>
              <button className="ghost" title="add subtask" onClick={() => onSub(t.num)}>+sub</button>
              <button className="ghost" title="make top-level" onClick={() => onParent(t.num, null)} disabled={t.parent_num == null}>⤤</button>
              <button className="ghost danger" title="delete" onClick={() => onDelete(t.num)}>🗑</button>
            </span>
          </div>
          {render(t.num, depth + 1)}
        </div>
      );
    });
  return <>{render(null, 0)}</>;
}
