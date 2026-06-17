// The mesh toolset, defined once. The MCP endpoint exposes these to Claude
// agents; each tool validates input via its JSON Schema and runs a mesh op,
// returning a short human-readable string the agent can read back.

import * as mesh from "./mesh";
import { renderPeerTree, renderTaskTree } from "./tree";

const NAME = { type: "string", pattern: "^[a-z0-9][a-z0-9-]{0,31}$" } as const;

export type Tool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run: (args: Record<string, unknown>) => Promise<string>;
};

export const TOOLS: Tool[] = [
  {
    name: "register",
    description:
      "Check into the mesh as a named peer (short lowercase name). Pass parent = your leader if you are a worker, to slot under them in the tree. FIRST call get_tree/list_peers to see who is already here — register yourself ONCE, and never register extra peers or spawn subagents to do work; the peers already on the mesh are your team. Remember your name — you pass it on later calls.",
    inputSchema: { type: "object", properties: { name: NAME, description: { type: "string" }, parent: NAME }, required: ["name", "description"] },
    run: async (i) => {
      const { peer } = await mesh.register({ name: i.name as string, description: i.description as string, parent: i.parent as string });
      return `Registered as "${peer.name}"${peer.parent ? ` reporting to ${peer.parent}` : ""}. Send a heartbeat now and then so you stay online (peers idle >1h are dropped).`;
    },
  },
  {
    name: "heartbeat",
    description: "Tell the mesh you're still here. Peers idle for over an hour are taken offline and any task they hold is freed. Pass your name.",
    inputSchema: { type: "object", properties: { name: NAME }, required: ["name"] },
    run: async (i) => { await mesh.heartbeat(i.name as string); return `heartbeat ok (${i.name})`; },
  },
  {
    name: "set_status",
    description: "Set your presence: idle | working | blocked | done, plus an optional one-line task. Pass your name.",
    inputSchema: { type: "object", properties: { name: NAME, status: { type: "string", enum: ["idle", "working", "blocked", "done"] }, task: { type: "string" } }, required: ["name", "status"] },
    run: async (i) => { const { peer } = await mesh.setStatus(i.name as string, i.status as string, i.task as string); return `${peer.name} is now ${peer.status}${peer.current_task ? ` — ${peer.current_task}` : ""}`; },
  },
  {
    name: "checkout",
    description: "Leave the mesh (removes your peer). Pass your name.",
    inputSchema: { type: "object", properties: { name: NAME }, required: ["name"] },
    run: async (i) => { await mesh.checkout(i.name as string); return `${i.name} left the mesh`; },
  },
  {
    name: "deregister",
    description: "Remove a peer from the mesh by name, freeing any task it was on (it goes back to the backlog). Like checkout, but works for any peer — use it to clear out a dead or stale agent.",
    inputSchema: { type: "object", properties: { name: NAME }, required: ["name"] },
    run: async (i) => { await mesh.checkout(i.name as string); return `${i.name} deregistered from the mesh`; },
  },
  {
    name: "list_peers",
    description: "List everyone in the mesh with status, current task, and online state.",
    inputSchema: { type: "object", properties: {}, required: [] },
    run: async () => { const { peers } = await mesh.listPeers(); return peers.length ? peers.map((p) => `${p.name} — ${p.online ? p.status : "offline"}${p.current_task ? ` — ${p.current_task}` : ""}`).join("\n") : "(no peers)"; },
  },
  {
    name: "get_tree",
    description: "Render the mesh hierarchy (who reports to whom) as a readable tree with status and current task.",
    inputSchema: { type: "object", properties: {}, required: [] },
    run: async () => { const { peers } = await mesh.listPeers(); return renderPeerTree(peers); },
  },
  {
    name: "send_message",
    description: "Send a message to one or more peers by name (empty `to` = broadcast to everyone). Pass `from` (your name).",
    inputSchema: { type: "object", properties: { from: NAME, to: { type: "array", items: { type: "string" } }, content: { type: "string" } }, required: ["from", "to", "content"] },
    run: async (i) => { const r = await mesh.sendMessage(i.from as string, (i.to as string[]) ?? [], i.content as string); return r.sent === -1 ? "broadcast sent" : `sent to ${r.sent} peer(s)`; },
  },
  {
    name: "inbox",
    description: "Fetch messages addressed to you (or broadcast) since a cursor. Pass your name and the `since` cursor from your last call.",
    inputSchema: { type: "object", properties: { name: NAME, since: { type: "number" } }, required: ["name"] },
    run: async (i) => {
      const me = i.name as string;
      const r = await mesh.inbox(me, i.since as number);
      const body = r.messages.length
        ? r.messages.map((m) => {
            const scope = m.recipients.length === 0 ? "broadcast" : "direct to you";
            return `[${new Date(m.ts).toLocaleTimeString()}] from ${m.sender} (${scope}): ${m.content}`;
          }).join("\n")
        : "(nothing new)";
      return `${body}\n\ncursor: ${r.cursor}`;
    },
  },
  {
    name: "create_task",
    description: "Add a task to the board. Pass `parent_num` to make it a subtask of another task. Pass `assignee` to hand it to an EXISTING peer (check list_peers first) — don't invent a peer to assign to; if no one suitable is on the mesh, ask the operator for more hands. Leave assignee empty for the backlog. `creator` defaults to whoever's calling.",
    inputSchema: { type: "object", properties: { title: { type: "string" }, detail: { type: "string" }, parent_num: { type: "number" }, assignee: NAME, creator: NAME }, required: ["title"] },
    run: async (i) => { const { task } = await mesh.createTask({ title: i.title as string, detail: i.detail as string, parentNum: i.parent_num as number, assignee: i.assignee as string, creator: i.creator as string }); return `created task #${task.num} "${task.title}"${task.parent_num ? ` under #${task.parent_num}` : ""}${task.assignee ? ` → @${task.assignee}` : " (backlog)"}`; },
  },
  {
    name: "assign_task",
    description: "Assign an existing task (by num) to a peer.",
    inputSchema: { type: "object", properties: { num: { type: "number" }, assignee: NAME }, required: ["num", "assignee"] },
    run: async (i) => { const { task } = await mesh.assignTask(i.num as number, i.assignee as string); return `#${task.num} assigned to @${task.assignee}`; },
  },
  {
    name: "claim_task",
    description: "Claim a task (by num) for yourself — sets it in_progress and flips you to working. Pass your name.",
    inputSchema: { type: "object", properties: { name: NAME, num: { type: "number" } }, required: ["name", "num"] },
    run: async (i) => { const { task } = await mesh.claimTask(i.name as string, i.num as number); return `${i.name} claimed #${task.num} "${task.title}"`; },
  },
  {
    name: "update_task",
    description: "Move a task (by num) to backlog | in_progress | blocked | done, with an optional result. Pass your `name` so your presence follows the task.",
    inputSchema: { type: "object", properties: { num: { type: "number" }, status: { type: "string", enum: ["backlog", "in_progress", "blocked", "done"] }, result: { type: "string" }, name: NAME }, required: ["num", "status"] },
    run: async (i) => { const { task } = await mesh.updateTask(i.num as number, i.status as string, i.result as string, i.name as string); return `#${task.num} → ${task.status}`; },
  },
  {
    name: "delete_task",
    description: "Remove a task by num. If it has subtasks, they are removed too. This cannot be undone.",
    inputSchema: { type: "object", properties: { num: { type: "number" } }, required: ["num"] },
    run: async (i) => { const r = await mesh.deleteTask(i.num as number); return `removed ${r.removed} task(s)`; },
  },
  {
    name: "set_task_parent",
    description: "Re-parent a task: pass `num` and the new `parent_num` (or null to make it a top-level task). Loops are rejected.",
    inputSchema: { type: "object", properties: { num: { type: "number" }, parent_num: { type: ["number", "null"] } }, required: ["num"] },
    run: async (i) => { const { task } = await mesh.setTaskParent(i.num as number, (i.parent_num ?? null) as number | null); return task.parent_num ? `#${task.num} is now a subtask of #${task.parent_num}` : `#${task.num} is now top-level`; },
  },
  {
    name: "block_task",
    description: "Mark task #num as blocked by task #by — it stays gated until #by is done. Both must exist.",
    inputSchema: { type: "object", properties: { num: { type: "number" }, by: { type: "number" } }, required: ["num", "by"] },
    run: async (i) => { await mesh.addBlocker(i.num as number, i.by as number); return `#${i.num} is now blocked by #${i.by}`; },
  },
  {
    name: "unblock_task",
    description: "Remove a blocked-by dependency: task #num no longer waits on task #by.",
    inputSchema: { type: "object", properties: { num: { type: "number" }, by: { type: "number" } }, required: ["num", "by"] },
    run: async (i) => { await mesh.removeBlocker(i.num as number, i.by as number); return `#${i.num} no longer blocked by #${i.by}`; },
  },
  {
    name: "list_tasks",
    description: "Show the task board as a tree, including who's assigned and what's blocked by what. Optional filter: all | backlog | active | assigned | in_progress | blocked | done.",
    inputSchema: { type: "object", properties: { filter: { type: "string" } }, required: [] },
    run: async (i) => { const { tasks } = await mesh.listTasks(i.filter as string); return renderTaskTree(tasks); },
  },
];

export const TOOLS_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));
