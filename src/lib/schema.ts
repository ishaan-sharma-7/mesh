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
`;
