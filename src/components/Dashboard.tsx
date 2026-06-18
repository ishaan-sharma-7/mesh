"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type Peer = { name: string; parent: string | null; status: string; current_task: string | null; online: boolean };
type Task = { num: number; title: string; status: string; assignee: string | null };
type Message = { id: number; sender: string; recipients: string[]; content: string; ts: string };
type State = { peers: Peer[]; tasks: Task[]; messages: Message[] };

const COLORS: Record<string, string> = { working: "#3fb950", idle: "#8b949e", blocked: "#f85149", done: "#58a6ff" };
const PALETTE = ["#58a6ff", "#3fb950", "#d29922", "#bc8cff", "#f778ba", "#56d4dd", "#ff7b72", "#a5d6ff"];
const color = (s: string) => COLORS[s] || "#8b949e";
const senderColor = (n: string) => PALETTE[[...n].reduce((a, c) => a + c.charCodeAt(0), 0) % PALETTE.length];
const MARK: Record<string, string> = { backlog: "○", in_progress: "◐", blocked: "⊘", done: "●" };

export default function Dashboard() {
  const [state, setState] = useState<State | null>(null);
  const feedRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);

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

  // keep the message feed pinned to the bottom unless the viewer scrolled up
  useEffect(() => {
    const el = feedRef.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [state]);

  async function logout() { await fetch("/api/auth", { method: "DELETE" }); window.location.reload(); }

  const peers = state?.peers ?? [];
  const tasks = state?.tasks ?? [];
  const messages = state?.messages ?? [];

  return (
    <div className="dash">
      <header className="dbar">
        <span className="dbrand">▚ mesh</span>
        <span className="dstat"><b>{peers.filter((p) => p.online).length}</b> online</span>
        <span className="dstat"><b>{peers.filter((p) => p.online && p.status === "working").length}</b> working</span>
        <span className="dstat"><b>{tasks.filter((t) => t.status !== "done").length}</b> open tasks</span>
        <span className="dstat"><b>{messages.length}</b> msgs</span>
        <span className="dspacer" />
        <button className="ghost" onClick={logout}>log out</button>
      </header>

      <div className="dwrap">
        <div className="dcol dorg">
          <h2>Org chart · who&apos;s doing what</h2>
          {peers.length === 0 ? <div className="dempty">no agents on the mesh</div> : <Org peers={peers} />}
        </div>

        <div className="dright">
          <div
            className="dfeed"
            ref={feedRef}
            onScroll={(e) => {
              const el = e.currentTarget;
              atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
            }}
          >
            <h2>Live messages</h2>
            {messages.length === 0 ? <div className="dempty">no messages yet</div> : messages.map((m) => {
              const bcast = !m.recipients.length;
              return (
                <div className="dmsg" key={m.id}>
                  <div className="dmeta">
                    <span className="dtime">{new Date(m.ts).toLocaleTimeString()}</span>
                    <span className="dfrom" style={{ color: senderColor(m.sender) }}>{m.sender}</span>
                    <span className={`dto ${bcast ? "bcast" : ""}`}>{bcast ? "→ all" : "→ " + m.recipients.join(", ")}</span>
                  </div>
                  <div className={`dbody ${m.content.length > 240 ? "long" : ""}`}>{m.content}</div>
                </div>
              );
            })}
          </div>

          <div className="dtasks">
            <h2>Task board</h2>
            {tasks.length === 0 ? <div className="dempty">no tasks</div> : tasks.map((t) => (
              <div className="dtrow" key={t.num}>
                <span className="dtmark" style={{ color: color(t.status === "in_progress" ? "working" : t.status === "backlog" ? "idle" : t.status) }}>{MARK[t.status] || "○"}</span>{" "}
                #{t.num} {t.title} {t.assignee && <span className="dtassignee">@{t.assignee}</span>}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function Org({ peers }: { peers: Peer[] }) {
  const names = new Set(peers.map((p) => p.name));
  const kids = new Map<string, Peer[]>();
  for (const p of peers) {
    const k = p.parent && names.has(p.parent) ? p.parent : "__root";
    (kids.get(k) ?? kids.set(k, []).get(k)!).push(p);
  }
  const node = (p: Peer): React.ReactNode => {
    const off = !p.online;
    const children = (kids.get(p.name) ?? []).sort((a, b) => a.name.localeCompare(b.name));
    return (
      <div className="dnode" key={p.name}>
        <div className={`dcard ${off ? "off" : ""}`}>
          <span className="ddot" style={{ background: off ? "#3a4150" : color(p.status) }} />
          <span className="dname">{p.name}</span>
          <span className="dpill" style={{ color: off ? "#8b949e" : color(p.status), borderColor: off ? "#3a4150" : color(p.status) }}>
            {off ? "offline" : p.status}
          </span>
          {p.current_task && <div className="dtask">{p.current_task}</div>}
        </div>
        {children.length > 0 && <div className="dkids">{children.map(node)}</div>}
      </div>
    );
  };
  const roots = (kids.get("__root") ?? []).sort((a, b) => a.name.localeCompare(b.name));
  return <>{roots.map(node)}</>;
}
