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
// "active" = the peer is genuinely doing work right now, not just connected. Two
// signals feed it, and NEITHER is the connection heartbeat:
//   - last_active : a real mesh action (a tool call) — bumped by touch().
//   - last_beat   : a turn-end from the Stop hook — the model completed a turn.
// We honor last_beat too because an agent heads-down on NON-mesh tools (grinding a
// CI poll-loop in Bash, driving a browser tab) makes zero mesh calls for minutes,
// so last_active goes stale even though it's hard at work — it kept ending turns.
// Without last_beat such an agent reads "idle" and gets falsely reassigned / its
// exclusive resource taken (the "phantom-idle" collisions). A truly idle agent
// stops ending turns too, so last_beat goes stale and it correctly falls to idle
// after the window. (Shrinking the window does NOT fix phantom-idle — it makes it
// worse; honoring the turn-end beat is the fix.)
export const ACTIVE_WINDOW_MS = 90 * 1000; // 90s
const activeCutoff = () => new Date(Date.now() - ACTIVE_WINDOW_MS);

// ---------- liveness watchdog ----------
// A Claude Code hook (Stop / StopFailure) POSTs a "beat" at every turn end, so we
// detect health from OUTSIDE the model — an agent killed by an API error can't
// report its own failure, but the hook (a plain shell command) still fires.
//   - a "stop" beat  = a turn completed normally → healthy, clears any error.
//   - an "error" beat = StopFailure: a turn aborted on an API error (overloaded /
//     rate_limit / ...). We DON'T wake it immediately — a throttled API won't
//     recover in 1s and re-hitting it makes things worse — so we cool down then
//     back off exponentially.
export const REVIVE_BASE_MS = 2 * 60 * 1000;   // first cooldown after an API error: 2 min
export const REVIVE_MAX_MS = 30 * 60 * 1000;   // backoff cap
export const BEAT_STALE_MS = 5 * 60 * 1000;    // inference fallback (no hook): silent-with-work this long = stalled
export const ACCOUNT_WIDE_MIN = 2;             // this many agents erroring at once = account-wide throttle, not isolated
// Peer-driven revival beats this code backstop: when at least one peer is UP it
// wakes downed teammates itself (the wake tool / a message), which is faster than
// the backoff above. So the code watchdog HOLDS OFF while a live "driver" exists
// and a down agent is still inside this grace — only stepping in once the peers'
// window has passed, OR when nobody is up to drive. Code is the backstop for the
// all-down case, not the default reviver.
export const PEER_REVIVE_GRACE_MS = 5 * 60 * 1000; // peers get 5 min before code backstops

export type PeerHealth = "ok" | "api_error" | "stalled" | "offline";

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const PEER_STATUS = ["idle", "working", "blocked", "done"] as const;
// 'design' = spec it but DON'T build until a leader/operator locks it (FIX 6).
const TASK_STATUS = ["backlog", "design", "in_progress", "blocked", "done"] as const;

export type PeerStatus = (typeof PEER_STATUS)[number];
export type TaskStatus = (typeof TASK_STATUS)[number];
type JsonPrimitive = null | string | number | boolean;
export type PeerCapabilityValue = JsonPrimitive | PeerCapabilityValue[] | { [key: string]: PeerCapabilityValue | undefined };
export type PeerCapabilities = { [key: string]: PeerCapabilityValue | undefined };

export class MeshError extends Error {}

function cleanShortText(value: unknown, field: string, max = 120): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new MeshError(`${field} must be a string`);
  const cleaned = value.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
  if (!cleaned) return null;
  return cleaned.slice(0, max);
}

function cleanCapabilities(value: unknown): PeerCapabilities | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw new MeshError("capabilities must be a JSON object");
  let json: string;
  try {
    json = JSON.stringify(value);
  } catch {
    throw new MeshError("capabilities must be JSON-serializable");
  }
  if (!json || json === "null" || json.length > 6000) throw new MeshError("capabilities must be a non-empty JSON object under 6KB");
  const parsed = JSON.parse(json) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new MeshError("capabilities must be a JSON object");
  return parsed as PeerCapabilities;
}

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
  host?: string | null; // the machine (hostname) this peer runs on
  harness?: string | null; // participant runtime, e.g. "pi" or "claude-code"
  model?: string | null; // current model/provider if the harness can report it
  capabilities?: PeerCapabilities | null; // small JSON summary of tool/features

  blocked_reason?: string | null;
  blocked_since?: string | null;
  effective_status?: PeerStatus; // honest derived status (see effectiveStatus)

  // liveness watchdog (see the watchdog section above + schema.ts)
  last_beat?: string | null;     // last healthy turn-end (Stop hook)
  api_error?: string | null;     // StopFailure error_type while erroring, else null
  error_since?: string | null;   // when the current error streak began
  revive_after?: string | null;  // don't attempt a wake before this (cooldown/backoff)
  health?: PeerHealth;           // derived: ok | api_error | stalled | offline
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

// Liveness health, separate from effectiveStatus (which is idle/working/blocked).
//   - offline  : not connected at all (reaper territory).
//   - api_error: a StopFailure beat marked it — the model was killed by an API
//                error. Precise + immediate. Cleared only by a healthy "stop" beat.
//   - stalled  : INFERENCE FALLBACK for agents without the hook — online, owns a
//                task, but has made zero progress (no beat, no tool call) for
//                BEAT_STALE_MS. Softer signal; the hook is the real one.
//   - ok       : healthy, or legitimately idle (no task pending).
export function computeHealth(p: {
  online?: boolean;
  api_error?: string | null;
  has_task?: boolean;
  last_beat?: string | null;
  last_active?: string | null;
  error_since?: string | null;
}): PeerHealth {
  if (p.online === false) return "offline";
  // A lingering api_error flag is only believed if the peer hasn't done real work
  // since the error began. last_active advancing past error_since means it's alive
  // and the flag is stale (the clearer just hasn't run yet) — don't keep showing it
  // DOWN. This is the display-side guard; clearDownOnActivity is the real cure.
  if (p.api_error) {
    const errAt = p.error_since ? new Date(p.error_since).getTime() : 0;
    const actAt = p.last_active ? new Date(p.last_active).getTime() : 0;
    if (!(actAt > errAt)) return "api_error";
  }
  if (p.has_task) {
    const last = Math.max(
      p.last_beat ? new Date(p.last_beat).getTime() : 0,
      p.last_active ? new Date(p.last_active).getTime() : 0,
    );
    if (last && Date.now() - last > BEAT_STALE_MS) return "stalled";
  }
  return "ok";
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
// heartbeat tool) — so these count as the peer actually doing something. Real
// activity is also proof of life, so it clears any stale API-error "down" flag
// (see clearDownOnActivity).
async function touch(name: string) {
  await sql`update peers set last_seen = now(), last_active = now() where name = ${name}`;
  await clearDownOnActivity(name);
}

// Real activity is proof of life. If `name` was flagged DOWN by an API-error beat
// (recordBeat 'error'), doing real work — sending a message, claiming/updating a
// task, setting status — means it's alive again, so clear the error streak now and
// close the loop with whoever was alerted. Without this a single transient one-turn
// API blip pins a still-working agent as DOWN on the dashboard (and keeps the
// auto-nudges firing) until a clean Stop beat happens to land — which can be many
// minutes if the agent is heads-down in a long turn. Best-effort: never let
// presence-healing break the action that triggered it.
async function clearDownOnActivity(name: string) {
  try {
    const [row] = await sql<{ parent: string | null }[]>`
      update peers set api_error = null, error_since = null, revive_after = null, revive_tries = 0
      where name = ${name} and api_error is not null
      returning parent`;
    if (row) await alertRecovery(name, row.parent);
  } catch {
    /* best-effort */
  }
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

// A system message from "mesh" addressed to specific peers (a leader to alert, a
// stalled agent to wake). Same push path as a normal directed message.
async function systemMessage(recipients: string[], content: string) {
  if (!recipients.length) return systemBroadcast(content);
  try {
    const [row] = await sql<{ id: number }[]>`
      insert into messages (sender, recipients, content) values ('mesh', ${recipients}, ${content}) returning id`;
    await sql`select pg_notify(${CHANNEL}, ${JSON.stringify({ id: Number(row.id), sender: "mesh", recipients, content })})`;
  } catch {
    /* best-effort */
  }
}

// ---------- peers ----------

export async function register(input: {
  name: string;
  description?: string;
  parent?: string;
  host?: string;
  harness?: string;
  model?: string;
  capabilities?: PeerCapabilities;
}): Promise<{ peer: Peer }> {
  const name = assertName(input.name);
  if (input.parent !== undefined && input.parent !== null) assertName(input.parent, "parent");
  if (input.parent === name) throw new MeshError("a peer cannot report to itself");
  const host = cleanShortText(input.host, "host", 80);
  const harness = cleanShortText(input.harness, "harness", 80);
  const model = cleanShortText(input.model, "model", 160);
  const capabilities = cleanCapabilities(input.capabilities);
  const existed = await sql`select 1 from peers where name = ${name}`;
  const [peer] = await sql<Peer[]>`
    insert into peers (name, description, parent, host, harness, model, capabilities, last_seen, last_active)
    values (${name}, ${input.description ?? null}, ${input.parent ?? null}, ${host}, ${harness}, ${model}, ${sql.json(capabilities ?? {})}::jsonb, now(), now())
    on conflict (name) do update set
      description  = coalesce(${input.description ?? null}, peers.description),
      parent       = coalesce(${input.parent ?? null}, peers.parent),
      host         = coalesce(${host}, peers.host),
      harness      = coalesce(${harness}, peers.harness),
      model        = coalesce(${model}, peers.model),
      capabilities = case when ${capabilities === null}::boolean then peers.capabilities else ${sql.json(capabilities ?? {})}::jsonb end,
      last_seen    = now(),
      last_active  = now()
    returning *, (last_seen > ${cutoff()}) as online, (last_active > ${activeCutoff()} or last_beat > ${activeCutoff()}) as active`;
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
    returning *, (last_seen > ${cutoff()}) as online, (last_active > ${activeCutoff()} or last_beat > ${activeCutoff()}) as active`;
  if (!peer) throw new MeshError(`no peer named "${name}" — register first`);
  await clearDownOnActivity(name); // setting status is proof of life
  peer.effective_status = effectiveStatus(peer);
  return { peer };
}

export async function setCapabilities(input: {
  name: string;
  harness?: string;
  model?: string;
  capabilities?: PeerCapabilities;
}): Promise<{ peer: Peer }> {
  const name = assertName(input.name);
  const harness = cleanShortText(input.harness, "harness", 80);
  const model = cleanShortText(input.model, "model", 160);
  const capabilities = cleanCapabilities(input.capabilities);
  if (harness === null && model === null && capabilities === null) {
    throw new MeshError("provide at least one of harness, model, or capabilities");
  }
  const [peer] = await sql<Peer[]>`
    update peers set
      harness      = coalesce(${harness}, peers.harness),
      model        = coalesce(${model}, peers.model),
      capabilities = case when ${capabilities === null}::boolean then peers.capabilities else ${sql.json(capabilities ?? {})}::jsonb end,
      last_seen    = now(),
      last_active  = now()
    where name = ${name}
    returning *, (last_seen > ${cutoff()}) as online, (last_active > ${activeCutoff()} or last_beat > ${activeCutoff()}) as active`;
  if (!peer) throw new MeshError(`no peer named "${name}" — register first`);
  await clearDownOnActivity(name); // updating capability metadata is proof of life
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

// Re-parent a peer in the org tree: move it under a different leader, or to the
// top level (parent = null). Loops are rejected. Doesn't require re-registering.
export async function setParent(name: string, parent: string | null): Promise<{ peer: Peer }> {
  assertName(name);
  if (parent != null) {
    assertName(parent, "parent");
    if (parent === name) throw new MeshError("a peer cannot report to itself");
    const [p] = await sql`select 1 from peers where name = ${parent}`;
    if (!p) throw new MeshError(`no peer named "${parent}"`);
    // walk up the parent chain from the proposed parent; if we reach `name`, it loops
    const [cyc] = await sql<{ cycle: boolean }[]>`
      with recursive chain as (
        select name, parent from peers where name = ${parent}
        union all
        select pe.name, pe.parent from peers pe join chain c on pe.name = c.parent
      ) select exists(select 1 from chain where name = ${name}) as cycle`;
    if (cyc?.cycle) throw new MeshError(`${parent} already reports (directly or not) under ${name} — that would make a loop`);
  }
  const [peer] = await sql<Peer[]>`
    update peers set parent = ${parent}
    where name = ${name}
    returning *, (last_seen > ${cutoff()}) as online, (last_active > ${activeCutoff()} or last_beat > ${activeCutoff()}) as active`;
  if (!peer) throw new MeshError(`no peer named "${name}" — register first`);
  return { peer };
}

export async function listPeers(): Promise<{ peers: Peer[] }> {
  const [peers, busy] = await Promise.all([
    sql<Peer[]>`
      select *, (last_seen > ${cutoff()}) as online, (last_active > ${activeCutoff()} or last_beat > ${activeCutoff()}) as active
      from peers order by name`,
    sql<{ assignee: string }[]>`select distinct assignee from tasks where status = 'in_progress' and assignee is not null`,
  ]);
  const owners = new Set(busy.map((b) => b.assignee));
  for (const p of peers) {
    p.has_task = owners.has(p.name); // owns an in-progress task -> heads-down work counts as working
    p.effective_status = effectiveStatus(p);
    p.health = computeHealth({
      online: p.online,
      api_error: p.api_error,
      has_task: p.has_task,
      last_beat: p.last_beat,
      last_active: (p as unknown as { last_active?: string }).last_active,
      error_since: p.error_since,
    });
  }
  return { peers };
}

// ---------- liveness watchdog: beats, alerts, revive ----------

// A turn-end beat from a Claude Code hook (the model-independent heartbeat).
//   stop  = healthy turn → clears any error streak.
//   error = StopFailure (API error) → mark + cool down (no instant wake).
//   idle  = parked waiting for input → proof of life only.
export async function recordBeat(input: { name: string; event: string; error_type?: string }): Promise<{ ok: true; health: PeerHealth }> {
  const name = assertName(input.name);
  const event = assertEnum(input.event, ["stop", "error", "idle"] as const, "event");

  if (event === "idle") {
    await sql`update peers set last_seen = now() where name = ${name}`;
    return { ok: true, health: "ok" };
  }
  if (event === "stop") {
    // Healthy turn end. If it was in an API-error streak, this is recovery — clear
    // it and close the loop with whoever we alerted.
    const [prev] = await sql<{ api_error: string | null; parent: string | null }[]>`select api_error, parent from peers where name = ${name}`;
    if (!prev) return { ok: true, health: "ok" }; // unknown/checked-out peer — a late beat must not error or resurrect it
    await sql`
      update peers set last_seen = now(), last_beat = now(),
        api_error = null, error_since = null, revive_after = null, revive_tries = 0
      where name = ${name}`;
    if (prev.api_error) await alertRecovery(name, prev.parent);
    return { ok: true, health: "ok" };
  }

  // event === "error": StopFailure. Cooldown uses the OLD revive_tries (0 on the
  // first hit -> base 2min) then increments, giving exponential backoff. We alert
  // only on the TRANSITION into erroring (error_since was null), not every beat.
  const et = (typeof input.error_type === "string" && input.error_type ? input.error_type : "unknown").slice(0, 40);
  const [prev] = await sql<{ error_since: string | null }[]>`select error_since from peers where name = ${name}`;
  if (!prev) return { ok: true, health: "ok" }; // unknown/checked-out peer — don't error or resurrect on a late beat
  const base = REVIVE_BASE_MS / 1000, max = REVIVE_MAX_MS / 1000;
  // backoff = base * 2^tries, capped, with ±15% jitter so agents that failed
  // together don't all become due in the same tick (thundering-herd on a throttled API).
  await sql`
    update peers set last_seen = now(),
      api_error = ${et},
      error_since = coalesce(error_since, now()),
      revive_after = now() + make_interval(secs => least(${max}::float8, ${base}::float8 * power(2, peers.revive_tries)) * (0.85 + random() * 0.3)),
      revive_tries = peers.revive_tries + 1
    where name = ${name}`;
  if (!prev.error_since) await alertStall(name, et);
  return { ok: true, health: "api_error" };
}

// Close the loop: tell whoever we alerted that the agent is back.
async function alertRecovery(name: string, parent: string | null) {
  if (parent) {
    await systemMessage([parent], `✓ ${name} recovered from its API error and is back working.`);
  } else {
    const kids = await sql<{ name: string }[]>`select name from peers where parent = ${name} and last_seen > ${cutoff()}`;
    const names = kids.map((k) => k.name);
    if (names.length) await systemMessage(names, `✓ Your leader ${name} recovered from its API error and is back coordinating.`);
  }
}

// Route a fresh stall alert. A worker's leader gets told to reassign; a top-level
// peer (CEO/lead) has no leader above it, so its WORKERS are told to hold (so they
// don't bottleneck) and the operator sees it on the dashboard. Account-wide throttle
// (many agents erroring at once) is called out so no one wastes effort.
async function alertStall(name: string, errorType: string) {
  const [{ count }] = await sql<{ count: number }[]>`
    select count(*)::int as count from peers where api_error is not null and last_seen > ${cutoff()}`;
  const orgWide = count >= ACCOUNT_WIDE_MIN ? " (Anthropic's API looks throttled org-wide — several agents hit it at once.)" : "";
  const [peer] = await sql<{ parent: string | null }[]>`select parent from peers where name = ${name}`;
  if (peer?.parent) {
    // worker down → tell its leader, who is usually up: YOU drive the revival. The
    // code backstop is slow; a peer wake is instant. Leader stays in the loop on
    // whether the WORK can wait.
    await systemMessage([peer.parent], `⚠ ${name} is DOWN — API error (${errorType}). You're up, so don't wait on the mesh's slow auto-revive — wake it yourself: call wake ${name} (or message it), and again as often as you need until it reports back. Code revival is only a backstop for when everyone's down. Reassign its task only if it genuinely can't wait.${orgWide}`);
  } else {
    // top-level (CEO/lead) down → no leader above it. Its reports are (usually) up,
    // so they drive the revival — code only has to carry the all-down case.
    const kids = await sql<{ name: string }[]>`select name from peers where parent = ${name} and last_seen > ${cutoff()}`;
    const names = kids.map((k) => k.name);
    if (names.length) {
      await systemMessage(names, `⚠ Your leader ${name} is DOWN — API error (${errorType}). You're up, so don't just wait — one of you wake it: call wake ${name} (or message it) every so often until it's back, instead of leaning on the slow code backstop. Keep finishing your own work meanwhile.${orgWide}`);
    }
  }
}

// Wake agents whose API-error cooldown has elapsed. Capped + ordered by oldest
// error so we stagger, never hammering a still-throttled API. Each attempt pushes
// the next one out with backoff, so a wake that doesn't take won't spam.
export async function reviveStalled(): Promise<{ revived: number }> {
  // Code is the BACKSTOP, not the default. If any peer is UP (online, not itself
  // down) it can wake downed teammates faster than this backoff — so while such a
  // "driver" exists, hold off until a down agent has been parked past the peer
  // grace (the live peers' window to wake it). With nobody up, revive immediately.
  const [{ drivers }] = await sql<{ drivers: number }[]>`
    select count(*)::int as drivers from peers where api_error is null and last_seen > ${cutoff()}`;
  const graceCutoff = new Date(Date.now() - PEER_REVIVE_GRACE_MS);
  const due = await sql<Peer[]>`
    select *, (last_seen > ${cutoff()}) as online from peers
    where api_error is not null and revive_after is not null and revive_after < now() and last_seen > ${cutoff()}
      -- but NOT if it has done real work since the error began (last_active past
      -- error_since): that's a live agent, and nudging it is noise (see worker-3).
      and (error_since is null or last_active is null or last_active <= error_since)
      -- backstop: if someone's up to drive revival, wait until the peer grace has
      -- passed before code steps in; if nobody's up (drivers = 0), revive now.
      and (${drivers}::int = 0 or error_since is null or error_since < ${graceCutoff})
    order by error_since asc nulls last
    limit 2`;
  if (!due.length) return { revived: 0 };
  const base = REVIVE_BASE_MS / 1000, max = REVIVE_MAX_MS / 1000;
  for (const p of due) {
    const mins = p.error_since ? Math.max(1, Math.round((Date.now() - new Date(p.error_since).getTime()) / 60000)) : 1;
    const [t] = await sql<{ num: number }[]>`select num from tasks where assignee = ${p.name} and status = 'in_progress' order by num limit 1`;
    const ref = t ? ` re-check your task #${t.num} and the board (list_tasks),` : " re-check the board (list_tasks),";
    await systemMessage([p.name], `(mesh auto-nudge) You were parked ~${mins}m ago by an API error (${p.api_error}). If you're back,${ref} resume your work and report your status. Still erroring? You'll be nudged again after a longer wait.`);
    await sql`update peers set
        revive_after = now() + make_interval(secs => least(${max}::float8, ${base}::float8 * power(2, peers.revive_tries)) * (0.85 + random() * 0.3)),
        revive_tries = peers.revive_tries + 1
      where name = ${p.name}`;
  }
  return { revived: due.length };
}

// Peer-driven revival. Any peer that's UP can wake a downed teammate itself —
// faster than the code backstop's 2→4→8min backoff. Pass `target` to wake one, or
// omit it to wake EVERY peer that currently looks down (API error, still online,
// not active since the error — a live agent doesn't need waking). Sends each a
// nudge (pushed live → wakes its session) and pushes its code-revive cooldown out
// so the server backstop doesn't pile on right after. Returns who got nudged.
export async function wakePeer(from: string, target?: string): Promise<{ woken: string[] }> {
  assertName(from);
  await touch(from); // waking a teammate is real activity — and proof YOU are up
  let names: string[];
  if (target !== undefined && target !== null && target !== "") {
    assertName(target, "target");
    // Explicit target: trust the caller — wake it as long as it's online (has a
    // session to wake) and isn't you.
    const rows = await sql<{ name: string }[]>`
      select name from peers where name = ${target} and last_seen > ${cutoff()} and name <> ${from}`;
    names = rows.map((r) => r.name);
  } else {
    // Wake-all: every peer that currently looks DOWN that you can see.
    const rows = await sql<{ name: string }[]>`
      select name from peers
      where api_error is not null and last_seen > ${cutoff()}
        and (error_since is null or last_active is null or last_active <= error_since)
        and name <> ${from}`;
    names = rows.map((r) => r.name);
  }
  if (!names.length) return { woken: [] };
  await systemMessage(
    names,
    `(wake from ${from}) You look DOWN from an API error and ${from} is checking on you. If you're back: re-check your inbox + the board (list_tasks), resume your work, and report your status so the team knows you're up.`,
  );
  // A peer just nudged these — push the code backstop's next attempt out so it
  // doesn't double-nudge on top of the peer wake.
  const base = REVIVE_BASE_MS / 1000, max = REVIVE_MAX_MS / 1000;
  await sql`update peers set
      revive_after = now() + make_interval(secs => least(${max}::float8, ${base}::float8 * power(2, revive_tries)) * (0.85 + random() * 0.3)),
      revive_tries = revive_tries + 1
    where name = any(${names}) and api_error is not null`;
  return { woken: names };
}

// ---------- resource leases ----------
// Advisory, auto-expiring ownership of a non-shareable resource so two agents
// never drive the same thing (an app port, a browser tab, a merge). See schema.ts.
// A holder renews by re-claiming; a downed holder's lease auto-expires so the
// resource is never stranded.
export const LEASE_TTL_MS = 15 * 60 * 1000; // 15 min default
const LEASE_TTL_MAX_MS = 6 * 60 * 60 * 1000; // cap a single lease at 6h
const RESOURCE_RE = /^[\w.:#/-]{1,80}$/;

export type Lease = {
  resource: string;
  holder: string;
  note: string | null;
  claimed_at: string;
  expires_at: string;
};

function assertResource(r: unknown): string {
  if (typeof r !== "string" || !RESOURCE_RE.test(r)) {
    throw new MeshError("resource must be a short id (letters, digits, . : # / -), e.g. 'localhost:3722', 'chrome:pr-303', or 'merge:#303'");
  }
  return r;
}

// Claim a resource. Free / expired / already-yours → granted (re-claiming renews
// the TTL). A DIFFERENT, unexpired holder → rejected, naming who holds it, so the
// caller doesn't drive over live work. Advisory: it gates the claim, not the
// external action — the protocol asks agents to claim before driving.
export async function claimResource(holder: string, resource: string, note?: string, ttlSec?: number): Promise<{ lease: Lease }> {
  assertName(holder);
  assertResource(resource);
  const [p] = await sql`select 1 from peers where name = ${holder}`;
  if (!p) throw new MeshError(`no peer named "${holder}" — register first`);
  await touch(holder); // claiming is real activity (and proof of life)
  const ttlMs = typeof ttlSec === "number" && ttlSec > 0 ? Math.min(ttlSec * 1000, LEASE_TTL_MAX_MS) : LEASE_TTL_MS;
  const expires = new Date(Date.now() + ttlMs);
  const [existing] = await sql<{ holder: string; expires_at: string; note: string | null }[]>`
    select holder, expires_at, note from leases where resource = ${resource} and expires_at > now()`;
  if (existing && existing.holder !== holder) {
    throw new MeshError(
      `"${resource}" is held by ${existing.holder} until ${new Date(existing.expires_at).toLocaleTimeString()}${existing.note ? ` (${existing.note})` : ""} — don't drive it. Coordinate with ${existing.holder} or wait for release.`,
    );
  }
  const [lease] = await sql<Lease[]>`
    insert into leases (resource, holder, note, claimed_at, expires_at)
    values (${resource}, ${holder}, ${note ?? null}, now(), ${expires})
    on conflict (resource) do update set holder = ${holder}, note = ${note ?? null}, claimed_at = now(), expires_at = ${expires}
    returning *`;
  return { lease };
}

// Release a resource you hold. Only the holder can release it. No-op (released:
// false) if you weren't the holder — never errors, so cleanup is safe to retry.
export async function releaseResource(holder: string, resource: string): Promise<{ released: boolean }> {
  assertName(holder);
  assertResource(resource);
  await touch(holder);
  const rows = await sql`delete from leases where resource = ${resource} and holder = ${holder} returning resource`;
  return { released: rows.length > 0 };
}

export async function listLeases(): Promise<{ leases: Lease[] }> {
  const leases = await sql<Lease[]>`select * from leases where expires_at > now() order by resource`;
  return { leases };
}

// Drop expired leases so a crashed holder never strands a resource. Cheap; runs
// in the once-a-minute sweep alongside the peer reaper.
async function reapLeases(): Promise<void> {
  await sql`delete from leases where expires_at <= now()`;
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
  accessed_at?: string; // last read or revised — drives expiry
  handle?: string; // "a<num>" — what messages reference
};
const ART_KINDS = ["note", "contract", "decision", "review", "spec"];

// Artifacts untouched (not read or revised) for this long get reaped, so stale
// docs don't hog the DB. Sliding window: any get_artifact bumps the clock, so
// anything still being referenced stays alive. ARTIFACT_TTL_HOURS=0 disables it.
export const ARTIFACT_TTL_HOURS = Math.max(0, Number(process.env.ARTIFACT_TTL_HOURS ?? 1) || 0);

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
  // reading the body counts as using it — bump accessed_at so the expiry clock
  // slides forward and an actively-referenced doc never gets reaped.
  const [a] = await sql<Artifact[]>`update artifacts set accessed_at = now() where num = ${handleToNum(handle)} returning *`;
  if (!a) throw new MeshError(`no artifact ${handle}`);
  a.handle = `a${a.num}`;
  return { artifact: a };
}

export async function updateArtifact(handle: string, content: string): Promise<{ artifact: Artifact }> {
  if (typeof content !== "string" || !content.trim()) throw new MeshError("content is required");
  const [a] = await sql<Artifact[]>`update artifacts set content = ${content}, updated_at = now(), accessed_at = now() where num = ${handleToNum(handle)} returning *`;
  if (!a) throw new MeshError(`no artifact ${handle}`);
  a.handle = `a${a.num}`;
  return { artifact: a };
}

export async function deleteArtifact(handle: string): Promise<{ ok: true; removed: number }> {
  const rows = await sql`delete from artifacts where num = ${handleToNum(handle)} returning num`;
  if (!rows.length) throw new MeshError(`no artifact ${handle}`);
  return { ok: true, removed: rows.length };
}

// Reap artifacts untouched past the TTL. Best-effort, called from the sweep.
// Quiet (no broadcast) — they're stale by definition, not worth a mesh ping.
export async function reapArtifacts(): Promise<{ artifactsRemoved: number }> {
  if (!(ARTIFACT_TTL_HOURS > 0)) return { artifactsRemoved: 0 }; // expiry disabled
  const rows = await sql`
    delete from artifacts
    where coalesce(accessed_at, updated_at, created_at) < now() - make_interval(secs => ${ARTIFACT_TTL_HOURS * 3600})
    returning num`;
  return { artifactsRemoved: rows.length };
}

export async function listArtifacts(): Promise<{ artifacts: Artifact[] }> {
  const artifacts = await sql<Artifact[]>`select num, kind, title, creator, created_at, updated_at, accessed_at from artifacts order by num desc limit 100`;
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
  await clearDownOnActivity(name); // claiming a task is proof of life
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
    await clearDownOnActivity(name); // updating a task is proof of life
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

export async function getState(): Promise<{ peers: Peer[]; tasks: Task[]; messages: Message[]; artifacts: Artifact[]; artifactTtlMs: number }> {
  await maybeReap();
  // Artifacts ship as metadata ONLY (no content) — the state snapshot is polled
  // every few seconds, and the bodies are multi-KB markdown docs. The dashboard
  // loads a body on demand via /api/mesh/artifact when you open one.
  const [peers, tasks, messages, artifacts] = await Promise.all([
    listPeers().then((r) => r.peers),
    listTasks("all").then((r) => r.tasks),
    sql<Message[]>`select id, sender, recipients, content, ts from messages order by ts desc limit 50`,
    listArtifacts().then((r) => r.artifacts),
  ]);
  return { peers, tasks, messages: messages.reverse(), artifacts, artifactTtlMs: ARTIFACT_TTL_HOURS * 3600 * 1000 };
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
    await reapArtifacts();  // drop artifacts untouched past the TTL
    await reapLeases();     // drop expired resource leases so nothing's stranded
    await reviveStalled(); // wake any agents whose API-error cooldown elapsed
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
