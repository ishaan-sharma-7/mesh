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
`;
