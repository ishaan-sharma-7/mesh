// The mesh schema, inlined so the server can apply it on boot (see
// src/instrumentation.ts). Safe to run repeatedly — every statement is guarded.

export const SCHEMA = /* sql */ `
-- Peers: a Claude agent (or a person) checked into the mesh, by short name.
-- parent gives the org tree. last_seen drives the 1-hour online window.
create table if not exists peers (
  name         text primary key,
  description  text,
  parent       text references peers(name) on delete set null,
  status       text not null default 'idle',  -- idle | working | blocked | done
  current_task text,
  last_seen    timestamptz not null default now(),
  created_at   timestamptz not null default now()
);

-- Tasks: a shared board with a parent/subtask tree.
-- Deleting a task removes its whole subtree (on delete cascade).
create table if not exists tasks (
  num        serial primary key,
  title      text not null,
  detail     text,
  parent_num integer references tasks(num) on delete cascade,
  status     text not null default 'backlog', -- backlog | in_progress | blocked | done
  assignee   text references peers(name) on delete set null,
  creator    text,
  result     text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Messages: peer-to-peer or broadcast (empty recipients = everyone).
create table if not exists messages (
  id         bigserial primary key,
  sender     text not null,
  recipients text[] not null default '{}',
  content    text not null,
  ts         timestamptz not null default now()
);

-- One task can be blocked by others. A task is "gated" until every task it's
-- blocked by is done. Separate from parent/subtask — this is a dependency edge.
create table if not exists task_deps (
  task_num   integer not null references tasks(num) on delete cascade,
  blocked_by integer not null references tasks(num) on delete cascade,
  primary key (task_num, blocked_by)
);

create index if not exists tasks_parent_idx on tasks(parent_num);
create index if not exists tasks_status_idx on tasks(status);
create index if not exists messages_ts_idx   on messages(ts);
create index if not exists task_deps_task_idx on task_deps(task_num);

-- Evolutions (idempotent). last_active tracks real activity (a tool call),
-- separate from last_seen which the connection heartbeat keeps fresh.
alter table peers add column if not exists last_active   timestamptz not null default now();
-- Structured blocked: why, and since when (so a stale block looks different).
alter table peers add column if not exists blocked_reason text;
alter table peers add column if not exists blocked_since  timestamptz;
-- PR/branch-stack note on a task ("bases on unmerged #238"), data not prose.
alter table tasks add column if not exists base text;
-- Which machine a peer runs on (hostname), so leaders know who's co-located vs
-- on a different computer (different files).
alter table peers add column if not exists host text;

-- Liveness watchdog. A Claude Code hook (Stop / StopFailure) POSTs a "beat" on
-- every turn end; these track health from OUTSIDE the model, so an agent killed
-- by an API error (which can't report its own failure) is still detected.
--   last_beat   : last healthy turn-end (Stop). Goes stale when the agent stalls.
--   api_error   : the StopFailure error_type (overloaded | rate_limit | ...), or null.
--   error_since : when the current api_error streak began (cleared on recovery).
--   revive_after: don't attempt a wake before this (cooldown + backoff — a throttled
--                 API won't recover in 1s, and hammering it makes it worse).
--   revive_tries: consecutive wake attempts, for exponential backoff.
alter table peers add column if not exists last_beat    timestamptz;
alter table peers add column if not exists api_error    text;
alter table peers add column if not exists error_since  timestamptz;
alter table peers add column if not exists revive_after timestamptz;
alter table peers add column if not exists revive_tries integer not null default 0;

-- Resource leases: one holder at a time for a NON-shareable resource (an app
-- port, a browser tab, a merge mechanic). Advisory + auto-expiring: a claim
-- REJECTS a conflicting claim so two agents never drive the same thing (the
-- "phantom-idle" collisions where a peer that looked idle got its live work taken
-- over), but nothing forces a claim — it's a cooperative marker on the board.
-- expires_at auto-frees a lease its holder can't release (e.g. it crashed), so a
-- downed agent never strands the resource. on delete cascade frees it if the
-- holder is reaped/checks out.
create table if not exists leases (
  resource   text primary key,
  holder     text not null references peers(name) on delete cascade,
  note       text,
  claimed_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index if not exists leases_holder_idx on leases(holder);

-- Artifacts: publish a contract/decision/review/spec ONCE, reference it by
-- handle (a<num>) in messages instead of re-pasting the whole body every relay.
create table if not exists artifacts (
  num        serial primary key,
  kind       text not null default 'note', -- note | contract | decision | review | spec
  title      text not null,
  content    text not null,
  creator    text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Artifact expiry: accessed_at is the last time the body was read (get_artifact)
-- or revised. The reaper deletes artifacts untouched past ARTIFACT_TTL_DAYS so
-- stale docs don't hog the DB forever. Backfill existing rows from their real
-- last timestamp (NOT now(), so the age clock reflects reality), then default
-- new rows to now().
alter table artifacts add column if not exists accessed_at timestamptz;
update artifacts set accessed_at = greatest(created_at, updated_at) where accessed_at is null;
alter table artifacts alter column accessed_at set default now();

-- One-time cleanup + baseline tied to the switch to a short (1-hour) TTL.
-- Uses its OWN guard column (ttl_cleanup) so it runs exactly once regardless of
-- any earlier baseline attempt — robust to deploy ordering:
--   • Keepers (num >= 48 — the active connector-security work) are PINNED fresh
--     (accessed_at = now()) so the short TTL doesn't expire docs published
--     before the switch.
--   • The two finished initiatives (num < 48 — the eval-harness and apartment
--     projects) are pushed past the TTL (accessed_at = 2h ago) so the reaper
--     retires them on the next sweep, even if a prior baseline freshened them.
-- Runs once per row, then never again; new rows are born already cleaned. On a
-- fresh DB there are no rows, so this no-ops.
alter table artifacts add column if not exists ttl_cleanup boolean not null default false;
update artifacts set accessed_at = now()                            where not ttl_cleanup and num >= 48;
update artifacts set accessed_at = now() - make_interval(hours => 2) where not ttl_cleanup and num <  48;
update artifacts set ttl_cleanup = true where not ttl_cleanup;
alter table artifacts alter column ttl_cleanup set default true;
`;
