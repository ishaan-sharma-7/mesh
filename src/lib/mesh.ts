// The mesh: every operation on peers, tasks, and messages lives here.
// Both the MCP endpoint (for Claude agents) and the REST API (for the website)
// call these functions, so the rules are identical no matter who's asking.

import { sql } from "./db";
import { CHANNEL } from "./bus";

// A peer is "online" if it has interacted within this window. Past it, the
// reaper takes it offline and frees any task it was holding. We compute the
// cutoff timestamp in JS and bind it as a parameter — clearer and safer than
// splicing a SQL interval string.
export const ONLINE_WINDOW_MS = 60 * 60 * 1000; // 1 hour — presence (online)
const cutoff = () => new Date(Date.now() - ONLINE_WINDOW_MS);
// last_active is bumped only by real actions (a tool call), never by the
// connection heartbeat — so "active" means actually doing things right now, not
// just connected. The dashboard uses this so a peer that set itself "working"
// then went quiet stops reading as working.
export const ACTIVE_WINDOW_MS = 90 * 1000; // 90s
const activeCutoff = () => new Date(Date.now() - ACTIVE_WINDOW_MS);

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const PEER_STATUS = ["idle", "working", "blocked", "done"] as const;
// 'design' = spec it but DON'T build until a leader/operator locks it (FIX 6).
const TASK_STATUS = ["backlog", "design", "in_progress", "blocked", "done"] as const;

export type PeerStatus = (typeof PEER_STATUS)[number];
export type TaskStatus = (typeof TASK_STATUS)[number];

export class MeshError extends Error {}

function assertName(name: unknown, field = "name"): string {
  if (typeof name !== "string" || !NAME_RE.test(name)) {
    throw new MeshError(`${field} must be a short lowercase id (a-z, 0-9, dashes), e.g. "abe" or "worker-2"`);
  }
  return name;
}

function assertEnum<T extends readonly string[]>(value: unknown, allowed: T, field: string): T[number] {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new MeshError(`${field} must be one of: ${allowed.join(" | ")}`);
  }
  return value;
}

export type Peer = {
  name: string;
  description: string | null;
  parent: string | null;
  status: PeerStatus;
  current_task: string | null;
  last_seen: string;
  online: boolean;
  active?: boolean; // did something in the last ACTIVE_WINDOW_MS (real activity, not heartbeat)
  has_task?: boolean; // owns an in-progress task (heads-down work counts as working)
  blocked_reason?: string | null;
  blocked_since?: string | null;
  effective_status?: PeerStatus; // honest derived status (see effectiveStatus)
};

// Status the dashboard/tools should show. Honors a reported 'blocked'/'done';
// otherwise "working" means it either pinged the mesh recently OR owns an
// in-progress task (so an agent heads-down building — not chatting — still reads
// as working, and a stale "working" flag with neither reads as idle).
export function effectiveStatus(p: { status: PeerStatus; active?: boolean; online?: boolean; has_task?: boolean }): PeerStatus {
  if (p.online === false) return "idle";
  if (p.status === "blocked" || p.status === "done") return p.status;
  return p.active || p.has_task ? "working" : "idle";
}

export type Task = {
  num: number;
  title: string;
  detail: string | null;
  parent_num: number | null;
  status: TaskStatus;
  assignee: string | null;
  creator: string | null;
  result: string | null;
  base: string | null; // PR/branch this work stacks on, e.g. "feat/x off #238"
  created_at: string;
  updated_at: string;
  blocked_by?: number[]; // every task this one waits on (populated by listTasks/getState)
  gating?: number[];     // subset of blocked_by that isn't done yet — what's actually holding it up
};

export type Message = {
  id: number;
  sender: string;
  recipients: string[];
  content: string;
  ts: string;
};

// Bump a peer's presence AND activity. Called on real actions (messages, inbox,
// heartbeat tool) — so these count as the peer actually doing something.
async function touch(name: string) {
  await sql`update peers set last_seen = now(), last_active = now() where name = ${name}`;
}

// A system broadcast from "mesh" — pushed to every agent like any message, used
// for presence events (joined / left / reaped) so the org stays aware of who's
// actually here and never assigns work to someone who's gone.
async function systemBroadcast(content: string) {
  try {
    const [row] = await sql<{ id: number }[]>`
      insert into messages (sender, recipients, content) values ('mesh', '{}', ${content}) returning id`;
    await sql`select pg_notify(${CHANNEL}, ${JSON.stringify({ id: Number(row.id), sender: "mesh", recipients: [], content })})`;
  } catch {
    /* best-effort */
  }
}

// ---------- peers ----------

export async function register(input: {
  name: string;
  description?: string;
  parent?: string;
}): Promise<{ peer: Peer }> {
  const name = assertName(input.name);
  if (input.parent !== undefined && input.parent !== null) assertName(input.parent, "parent");
  if (input.parent === name) throw new MeshError("a peer cannot report to itself");
  const existed = await sql`select 1 from peers where name = ${name}`;
  const [peer] = await sql<Peer[]>`
    insert into peers (name, description, parent, last_seen, last_active)
    values (${name}, ${input.description ?? null}, ${input.parent ?? null}, now(), now())
    on conflict (name) do update set
      description = coalesce(${input.description ?? null}, peers.description),
      parent      = coalesce(${input.parent ?? null}, peers.parent),
      last_seen   = now(),
      last_active = now()
    returning *, (last_seen > ${cutoff()}) as online, (last_active > ${activeCutoff()}) as active`;
  if (existed.length === 0) {
    await systemBroadcast(`${name} JOINED the mesh${input.parent ? `, reporting to ${input.parent}` : " (top-level leader)"}.`);
  }
  return { peer };
}

export async function heartbeat(name: string): Promise<{ ok: true }> {
  assertName(name);
  await touch(name);
  return { ok: true };
}

export async function setStatus(name: string, status: string, task?: string): Promise<{ peer: Peer }> {
  assertName(name);
  const s = assertEnum(status, PEER_STATUS, "status");
  const blocked = s === "blocked";
  // structured blocked: the reason is the status line; blocked_since is kept
  // from when the block started (not reset on every nudge), cleared on unblock.
  const [peer] = await sql<Peer[]>`
    update peers set status = ${s}, current_task = ${task ?? null}, last_seen = now(), last_active = now(),
      blocked_reason = ${blocked ? (task ?? null) : null},
      blocked_since  = case when ${blocked} then coalesce(blocked_since, now()) else null end
    where name = ${name}
    returning *, (last_seen > ${cutoff()}) as online, (last_active > ${activeCutoff()}) as active`;
  if (!peer) throw new MeshError(`no peer named "${name}" — register first`);
  peer.effective_status = effectiveStatus(peer);
  return { peer };
}

// Remove a peer from the mesh and free anything it was holding — any task it was
// on drops back to the backlog (same as when the reaper takes an idle peer).
export async function checkout(name: string): Promise<{ ok: true }> {
  assertName(name);
  const [freed] = await sql.begin(async (tx) => {
    const f = await tx`
      update tasks set assignee = null,
        status = case when status = 'in_progress' then 'backlog' else status end,
        updated_at = now()
      where assignee = ${name} returning num`;
    const existed = await tx`delete from peers where name = ${name} returning name`;
    return [{ freed: f.length, existed: existed.length }];
  });
  if (freed.existed) {
    const tasks = freed.freed ? ` Its ${freed.freed} task(s) dropped back to the backlog — reassign if they still matter.` : "";
    await systemBroadcast(`${name} LEFT the mesh.${tasks} Do not assign work to ${name} or wait on it.`);
  }
  return { ok: true };
}

export async function listPeers(): Promise<{ peers: Peer[] }> {
  const [peers, busy] = await Promise.all([
    sql<Peer[]>`
      select *, (last_seen > ${cutoff()}) as online, (last_active > ${activeCutoff()}) as active
      from peers order by name`,
    sql<{ assignee: string }[]>`select distinct assignee from tasks where status = 'in_progress' and assignee is not null`,
  ]);
  const owners = new Set(busy.map((b) => b.assignee));
  for (const p of peers) {
    p.has_task = owners.has(p.name); // owns an in-progress task -> heads-down work counts as working
    p.effective_status = effectiveStatus(p);
  }
  return { peers };
}

// ---------- messages ----------

export async function sendMessage(from: string, to: string[], content: string): Promise<{ ok: true; sent: number }> {
  assertName(from);
  if (!Array.isArray(to)) throw new MeshError("`to` must be an array of peer names (empty = broadcast)");
  to.forEach((t) => assertName(t, "recipient"));
  if (typeof content !== "string" || !content.trim()) throw new MeshError("content is required");
  await touch(from);
  const [row] = await sql<{ id: number }[]>`
    insert into messages (sender, recipients, content) values (${from}, ${to}, ${content}) returning id`;
  // Fire a NOTIFY so any open SSE stream pushes this to its peer instantly.
  // Content is capped to stay under Postgres' ~8KB NOTIFY limit; a rare longer
  // message is still readable in full via inbox.
  try {
    const payload = JSON.stringify({
      id: Number(row.id),
      sender: from,
      recipients: to,
      content: content.length > 6000 ? content.slice(0, 6000) + " […truncated, see inbox]" : content,
    });
    await sql`select pg_notify(${CHANNEL}, ${payload})`;
  } catch {
    /* best-effort; the channel's reconnect catch-up is the backstop */
  }
  return { ok: true, sent: to.length || -1 };
}

// `since` is an opaque cursor = the last message id seen. Using the id (not a
// timestamp) makes it exact — Postgres ts has microsecond precision that a JS
// millisecond cursor would truncate, re-matching the last message forever.
export async function inbox(name: string, since?: number): Promise<{ messages: Message[]; cursor: number }> {
  assertName(name);
  await touch(name);
  const sinceId = since ?? 0;
  const messages = await sql<Message[]>`
    select id, sender, recipients, content, ts
    from messages
    where id > ${sinceId}
      and sender <> ${name}
      and (cardinality(recipients) = 0 or ${name} = any(recipients))
    order by id asc limit 200`;
  const cursor = messages.length ? Number(messages[messages.length - 1].id) : sinceId;
  return { messages, cursor };
}

// The full recent conversation — every message between every peer, not just one
// peer's inbox. For a reviewer evaluating a run, or a human reading the transcript.
export async function getHistory(limit = 50): Promise<{ messages: Message[] }> {
  const n = Math.max(1, Math.min(200, Math.floor(Number(limit)) || 50));
  const rows = await sql<Message[]>`
    select id, sender, recipients, content, ts from messages order by id desc limit ${n}`;
  return { messages: rows.reverse() };
}

// ---------- artifacts (publish once, reference by handle) ----------

export type Artifact = {
  num: number;
  kind: string;
  title: string;
  content: string;
  creator: string | null;
  created_at: string;
  updated_at: string;
  handle?: string; // "a<num>" — what messages reference
};
const ART_KINDS = ["note", "contract", "decision", "review", "spec"];

function handleToNum(handle: string): number {
  const m = /^@?a?(\d+)$/i.exec(String(handle).trim());
  if (!m) throw new MeshError(`bad artifact handle "${handle}" — use like a3 or @a3`);
  return Number(m[1]);
}

export async function createArtifact(input: { title: string; content: string; kind?: string; creator?: string }): Promise<{ artifact: Artifact }> {
  if (typeof input.title !== "string" || !input.title.trim()) throw new MeshError("title is required");
  if (typeof input.content !== "string" || !input.content.trim()) throw new MeshError("content is required");
  const kind = input.kind && ART_KINDS.includes(input.kind) ? input.kind : "note";
  const [a] = await sql<Artifact[]>`
    insert into artifacts (kind, title, content, creator)
    values (${kind}, ${input.title.trim()}, ${input.content}, ${input.creator ?? null}) returning *`;
  a.handle = `a${a.num}`;
  return { artifact: a };
}

export async function getArtifact(handle: string): Promise<{ artifact: Artifact }> {
  const [a] = await sql<Artifact[]>`select * from artifacts where num = ${handleToNum(handle)}`;
  if (!a) throw new MeshError(`no artifact ${handle}`);
  a.handle = `a${a.num}`;
  return { artifact: a };
}

export async function updateArtifact(handle: string, content: string): Promise<{ artifact: Artifact }> {
  if (typeof content !== "string" || !content.trim()) throw new MeshError("content is required");
  const [a] = await sql<Artifact[]>`update artifacts set content = ${content}, updated_at = now() where num = ${handleToNum(handle)} returning *`;
  if (!a) throw new MeshError(`no artifact ${handle}`);
  a.handle = `a${a.num}`;
  return { artifact: a };
}

export async function listArtifacts(): Promise<{ artifacts: Artifact[] }> {
  const artifacts = await sql<Artifact[]>`select num, kind, title, creator, created_at, updated_at from artifacts order by num desc limit 100`;
  for (const a of artifacts) a.handle = `a${a.num}`;
  return { artifacts };
}

// ---------- tasks ----------

export async function createTask(input: {
  title: string;
  detail?: string;
  parentNum?: number | null;
  assignee?: string;
  creator?: string;
  base?: string;
  design?: boolean; // spec-lock: don't build until a leader/operator moves it off 'design'
}): Promise<{ task: Task }> {
  if (typeof input.title !== "string" || !input.title.trim()) throw new MeshError("title is required");
  if (input.assignee) assertName(input.assignee, "assignee");
  if (input.parentNum != null) {
    const [p] = await sql`select num from tasks where num = ${input.parentNum}`;
    if (!p) throw new MeshError(`parent task #${input.parentNum} does not exist`);
  }
  const status = input.design ? "design" : input.assignee ? "in_progress" : "backlog";
  const [task] = await sql<Task[]>`
    insert into tasks (title, detail, parent_num, assignee, creator, status, base)
    values (${input.title.trim()}, ${input.detail ?? null}, ${input.parentNum ?? null},
            ${input.assignee ?? null}, ${input.creator ?? null}, ${status}, ${input.base ?? null})
    returning *`;
  return { task };
}

export async function assignTask(num: number, assignee: string): Promise<{ task: Task }> {
  assertName(assignee, "assignee");
  const [task] = await sql<Task[]>`
    update tasks set assignee = ${assignee},
      status = case when status = 'backlog' then 'in_progress' else status end,
      updated_at = now()
    where num = ${num} returning *`;
  if (!task) throw new MeshError(`no task #${num}`);
  return { task };
}

export async function claimTask(name: string, num: number): Promise<{ task: Task }> {
  assertName(name);
  const [task] = await sql<Task[]>`
    update tasks set assignee = ${name}, status = 'in_progress', updated_at = now()
    where num = ${num} returning *`;
  if (!task) throw new MeshError(`no task #${num}`);
  await sql`update peers set status = 'working', current_task = ${task.title}, last_seen = now(), last_active = now() where name = ${name}`;
  return { task };
}

export async function updateTask(num: number, status: string, result?: string, name?: string): Promise<{ task: Task }> {
  const s = assertEnum(status, TASK_STATUS, "status");
  const [task] = await sql<Task[]>`
    update tasks set status = ${s},
      result = coalesce(${result ?? null}, result),
      assignee = case when ${s} = 'backlog' then null else assignee end,
      updated_at = now()
    where num = ${num} returning *`;
  if (!task) throw new MeshError(`no task #${num}`);
  if (name) {
    assertName(name);
    await sql`update peers set last_seen = now(), last_active = now(),
      status = case when ${s} = 'done' then 'idle' else 'working' end,
      current_task = case when ${s} = 'done' then null else ${task.title} end
      where name = ${name}`;
  }
  return { task };
}

export async function deleteTask(num: number): Promise<{ ok: true; removed: number }> {
  // Count the subtree so we can report what went with it.
  const [{ count }] = await sql<{ count: number }[]>`
    with recursive sub as (
      select num from tasks where num = ${num}
      union all
      select t.num from tasks t join sub on t.parent_num = sub.num
    ) select count(*)::int as count from sub`;
  if (count === 0) throw new MeshError(`no task #${num}`);
  await sql`delete from tasks where num = ${num}`; // children cascade
  return { ok: true, removed: count };
}

export async function setTaskParent(num: number, parentNum: number | null): Promise<{ task: Task }> {
  if (parentNum != null) {
    if (parentNum === num) throw new MeshError("a task cannot be its own parent");
    // Walk down from num; if we reach parentNum, this would make a cycle.
    const [cycle] = await sql<{ hit: boolean }[]>`
      with recursive sub as (
        select num from tasks where num = ${num}
        union all
        select t.num from tasks t join sub on t.parent_num = sub.num
      ) select exists(select 1 from sub where num = ${parentNum}) as hit`;
    if (cycle?.hit) throw new MeshError(`task #${parentNum} is already under #${num} — that would make a loop`);
    const [p] = await sql`select num from tasks where num = ${parentNum}`;
    if (!p) throw new MeshError(`parent task #${parentNum} does not exist`);
  }
  const [task] = await sql<Task[]>`update tasks set parent_num = ${parentNum}, updated_at = now() where num = ${num} returning *`;
  if (!task) throw new MeshError(`no task #${num}`);
  return { task };
}

export async function listTasks(filter?: string): Promise<{ tasks: Task[] }> {
  const f = filter ?? "all";
  let where = sql``;
  if (f === "backlog") where = sql`where status = 'backlog'`;
  else if (f === "active") where = sql`where status in ('in_progress', 'blocked')`;
  else if (f === "live") where = sql`where status <> 'done'`; // everything still open
  else if (f === "assigned") where = sql`where assignee is not null`;
  else if (TASK_STATUS.includes(f as TaskStatus)) where = sql`where status = ${f}`;
  const [tasks, deps, doneRows] = await Promise.all([
    sql<Task[]>`select * from tasks ${where} order by num`,
    sql<{ task_num: number; blocked_by: number }[]>`select task_num, blocked_by from task_deps`,
    sql<{ num: number }[]>`select num from tasks where status = 'done'`,
  ]);
  const byTask = new Map<number, number[]>();
  for (const d of deps) (byTask.get(d.task_num) ?? byTask.set(d.task_num, []).get(d.task_num)!).push(d.blocked_by);
  const done = new Set(doneRows.map((r) => r.num)); // done-ness from ALL tasks, so filtered views stay correct
  for (const t of tasks) {
    const all = (byTask.get(t.num) ?? []).sort((a, b) => a - b);
    t.blocked_by = all;
    t.gating = all.filter((n) => !done.has(n));
  }
  return { tasks };
}

// task #num is blocked by task #by. Both must exist and differ, and the new
// edge must not create a cycle (e.g. #by already waits on #num, directly or not).
export async function addBlocker(num: number, by: number): Promise<{ ok: true }> {
  if (num === by) throw new MeshError("a task can't block itself");
  const rows = await sql`select num from tasks where num in (${num}, ${by})`;
  if (rows.length < 2) throw new MeshError("both tasks must exist");
  const [cyc] = await sql<{ cycle: boolean }[]>`
    with recursive chain as (
      select blocked_by from task_deps where task_num = ${by}
      union all
      select d.blocked_by from task_deps d join chain c on d.task_num = c.blocked_by
    ) select exists(select 1 from chain where blocked_by = ${num}) as cycle`;
  if (cyc?.cycle) throw new MeshError(`#${by} already waits on #${num} — that would make a loop`);
  await sql`insert into task_deps (task_num, blocked_by) values (${num}, ${by}) on conflict do nothing`;
  return { ok: true };
}

export async function removeBlocker(num: number, by: number): Promise<{ ok: true }> {
  await sql`delete from task_deps where task_num = ${num} and blocked_by = ${by}`;
  return { ok: true };
}

// ---------- snapshot + reaper ----------

export async function getState(): Promise<{ peers: Peer[]; tasks: Task[]; messages: Message[] }> {
  await maybeReap();
  const [peers, tasks, messages] = await Promise.all([
    listPeers().then((r) => r.peers),
    listTasks("all").then((r) => r.tasks),
    sql<Message[]>`select id, sender, recipients, content, ts from messages order by ts desc limit 50`,
  ]);
  return { peers, tasks, messages: messages.reverse() };
}

declare global {
  // eslint-disable-next-line no-var
  var __clmesh_lastReap: number | undefined;
}

// Sweep at most once a minute, triggered by real activity (dashboard polls,
// agent calls). Keeps the mesh self-cleaning without a frequent cron.
export async function maybeReap(): Promise<void> {
  const now = Date.now();
  if (now - (globalThis.__clmesh_lastReap ?? 0) < 60_000) return;
  globalThis.__clmesh_lastReap = now;
  try {
    await reap();
  } catch {
    // best effort — a failed sweep shouldn't break the request
  }
}

// Take idle peers offline and free any task they were holding. Idempotent.
// Runs in one transaction against a single snapshot of who's stale, so a
// heartbeat landing mid-sweep can't leave a task orphaned with no owner.
export async function reap(): Promise<{ peersRemoved: number; tasksFreed: number }> {
  const { names, tasksFreed } = await sql.begin(async (tx) => {
    const stale = await tx<{ name: string }[]>`select name from peers where last_seen < ${cutoff()}`;
    const ns = stale.map((s) => s.name);
    if (ns.length === 0) return { names: [] as string[], tasksFreed: 0 };
    const freed = await tx`
      update tasks set assignee = null,
        status = case when status = 'in_progress' then 'backlog' else status end,
        updated_at = now()
      where assignee = any(${ns}) returning num`;
    await tx`delete from peers where name = any(${ns})`;
    return { names: ns, tasksFreed: freed.length };
  });
  if (names.length) {
    await systemBroadcast(`${names.join(", ")} went OFFLINE (idle, dropped by the reaper) and left the mesh. Any tasks they held are back in the backlog. Don't wait on them.`);
  }
  return { peersRemoved: names.length, tasksFreed };
}
