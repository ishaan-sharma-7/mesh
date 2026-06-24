// The mesh toolset, defined once. The MCP endpoint exposes these to Claude
// agents; each tool validates input via its JSON Schema and runs a mesh op,
// returning a short human-readable string the agent can read back.

import * as mesh from "./mesh";
import { renderPeerTree, renderTaskTree } from "./tree";

const NAME = { type: "string", pattern: "^[a-z0-9][a-z0-9-]{0,31}$" } as const;
const CAPABILITIES = {
  type: "object",
  additionalProperties: true,
  description: "Small JSON object describing this harness' useful tools/features, e.g. {features:[\"shell\",\"browser\"], tools:[\"bash\",\"browser_open\"]}",
} as const;

function stringList(value: unknown, limit = 8): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string" && v.trim().length > 0).map((v) => v.trim()).slice(0, limit);
}

function capabilityWords(p: mesh.Peer, limit = 8): string[] {
  const c = p.capabilities && typeof p.capabilities === "object" ? p.capabilities : {};
  const words = new Set<string>();
  const flags: [string, string][] = [
    ["shell", "shell"],
    ["fileRead", "read"],
    ["fileEdit", "edit"],
    ["web", "web"],
    ["browser", "browser"],
    ["livePush", "live-push"],
    ["apiErrorWatchdog", "watchdog"],
  ];
  for (const [key, label] of flags) if ((c as Record<string, unknown>)[key] === true) words.add(label);
  for (const f of stringList((c as Record<string, unknown>).features, limit)) words.add(f);
  for (const t of stringList((c as Record<string, unknown>).tools, limit)) words.add(t);
  return [...words].slice(0, limit);
}

function peerMeta(p: mesh.Peer): string {
  const bits: string[] = [];
  if (p.host) bits.push(`@${p.host}`);
  if (p.harness) bits.push(p.harness);
  if (p.model) bits.push(p.model);
  const caps = capabilityWords(p, 6);
  if (caps.length) bits.push(`caps: ${caps.join(", ")}`);
  return bits.length ? ` [${bits.join(" · ")}]` : "";
}

function formatCapabilities(p: mesh.Peer): string {
  const lines = [`${p.name}${peerMeta(p)}`];
  const c = p.capabilities && typeof p.capabilities === "object" ? (p.capabilities as Record<string, unknown>) : {};
  const features = stringList(c.features, 20);
  const tools = stringList(c.tools, 30);
  const commands = stringList(c.commands, 20);
  if (features.length) lines.push(`  features: ${features.join(", ")}`);
  if (tools.length) lines.push(`  tools: ${tools.join(", ")}`);
  if (commands.length) lines.push(`  commands: ${commands.join(", ")}`);
  const extra = Object.entries(c)
    .filter(([k, v]) => !["features", "tools", "commands"].includes(k) && ["string", "number", "boolean"].includes(typeof v))
    .slice(0, 12)
    .map(([k, v]) => `${k}=${String(v)}`);
  if (extra.length) lines.push(`  metadata: ${extra.join(", ")}`);
  if (lines.length === 1) lines.push("  capabilities: not reported");
  return lines.join("\n");
}

// Re-injected on the moments an agent defines or takes on work, so "write the
// board for a human overseer" stays consistent instead of fading after connect.
const PLAIN_TITLE = "\n→ Keep the title a SHORT plain phrase a non-expert reads at a glance; the full spec goes in the detail field, not the title.";
const PLAIN_STATUS = "\n→ Now set_status with a SHORT plain line of what you're doing — the dashboard shows it to a human overseer, so make it readable to someone with zero context.";
const TOO_LONG = "\n→ That status line is long/technical — shorten it to a plain phrase an overseer can read; the dashboard shows it verbatim.";

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
      "Check into the mesh as a named peer (short lowercase name). Pass parent = your leader if you are a worker, to slot under them in the tree. Your harness bridge should include host/harness/model/capabilities when it can (Pi/Claude Code do this automatically). FIRST call get_tree/list_peers to see who is already here — register yourself ONCE, and never register extra peers or spawn subagents to do work; the peers already on the mesh are your team. Remember your name — you pass it on later calls.",
    inputSchema: { type: "object", properties: { name: NAME, description: { type: "string" }, parent: NAME, host: { type: "string" }, harness: { type: "string" }, model: { type: "string" }, capabilities: CAPABILITIES }, required: ["name", "description"] },
    run: async (i) => {
      const { peer } = await mesh.register({ name: i.name as string, description: i.description as string, parent: i.parent as string, host: i.host as string, harness: i.harness as string, model: i.model as string, capabilities: i.capabilities as mesh.PeerCapabilities });
      const meta = peerMeta(peer);
      return `Registered as "${peer.name}"${peer.parent ? ` reporting to ${peer.parent}` : ""}${meta}. Your open connection keeps you online automatically — you do NOT need to call heartbeat in a loop; just do your work and the mesh tracks your presence.`;
    },
  },
  {
    name: "heartbeat",
    description: "RARELY NEEDED. Your live connection already keeps you online while you're working — the mesh tracks presence on its own and your turn-ends count as activity, so you do NOT heartbeat in a loop. Only use this if you've been off the live channel for a long stretch and want to prove you're still here (peers idle over an hour are taken offline and any task they hold is freed). Pass your name.",
    inputSchema: { type: "object", properties: { name: NAME }, required: ["name"] },
    run: async (i) => { await mesh.heartbeat(i.name as string); return `heartbeat ok (${i.name})`; },
  },
  {
    name: "set_status",
    description:
      "Set your presence: working | blocked | idle | done, plus a SHORT one-line `task` summary of what you're doing RIGHT NOW. When status is `blocked`, put the REASON in `task` (e.g. 'waiting on operator decision', 'blocked on #21', 'needs OpenAI key') — blocked-on-operator and blocked-on-dependency are legitimate, NOT idle; never fake work to look busy. The dashboard shows your line as the source of truth, so keep it current. (Status also auto-derives from activity: a 'working' line you stop touching reads as idle, so set_status is for the nuance, especially blocked.)",
    inputSchema: { type: "object", properties: { name: NAME, status: { type: "string", enum: ["idle", "working", "blocked", "done"] }, task: { type: "string" } }, required: ["name", "status"] },
    run: async (i) => { const { peer } = await mesh.setStatus(i.name as string, i.status as string, i.task as string); const tooLong = typeof i.task === "string" && i.task.length > 90 ? TOO_LONG : ""; return `${peer.name} is now ${peer.effective_status ?? peer.status}${peer.current_task ? ` — ${peer.current_task}` : ""}${tooLong}`; },
  },
  {
    name: "set_capabilities",
    description:
      "Update your published harness/model/capability metadata (normally done automatically by the local Pi or Claude Code bridge). Use this when your model or tool surface changes so leaders can assign work based on who has shell, browser, web, file-edit, or other capabilities.",
    inputSchema: { type: "object", properties: { name: NAME, harness: { type: "string" }, model: { type: "string" }, capabilities: CAPABILITIES }, required: ["name"] },
    run: async (i) => {
      const { peer } = await mesh.setCapabilities({ name: i.name as string, harness: i.harness as string, model: i.model as string, capabilities: i.capabilities as mesh.PeerCapabilities });
      return `updated ${peer.name} capabilities${peerMeta(peer)}`;
    },
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
    name: "set_parent",
    description:
      "Re-parent a peer in the org tree: pass `name` and the new `parent` (another peer's name), or omit `parent` to make them a top-level leader. Use this to move a worker under a different manager — e.g. when you borrow someone from another operator for a task — without making them re-register. Loops are rejected.",
    inputSchema: { type: "object", properties: { name: NAME, parent: NAME }, required: ["name"] },
    run: async (i) => { const { peer } = await mesh.setParent(i.name as string, (i.parent ?? null) as string | null); return peer.parent ? `${peer.name} now reports to ${peer.parent}` : `${peer.name} is now a top-level leader`; },
  },
  {
    name: "list_peers",
    description: "List everyone in the mesh with their (activity-derived) status, host, harness/model/capability summary, what they're doing, and online state. Blocked peers show their reason.",
    inputSchema: { type: "object", properties: {}, required: [] },
    run: async () => {
      const { peers } = await mesh.listPeers();
      if (!peers.length) return "(no peers)";
      return peers.map((p) => {
        const st = p.online ? (p.effective_status ?? p.status) : "offline";
        const b = st === "blocked" && p.blocked_reason ? ` (${p.blocked_reason})` : "";
        const t = p.current_task && st !== "blocked" ? ` — ${p.current_task}` : "";
        return `${p.name}${peerMeta(p)} — ${st}${b}${t}`;
      }).join("\n");
    },
  },
  {
    name: "list_capabilities",
    description: "List each current peer's published host, harness, model, tools, and feature metadata so leaders can choose the right agent for browser/web/shell/file-edit work.",
    inputSchema: { type: "object", properties: {}, required: [] },
    run: async () => {
      const { peers } = await mesh.listPeers();
      return peers.length ? peers.map(formatCapabilities).join("\n\n") : "(no peers)";
    },
  },
  {
    name: "get_tree",
    description: "Render the mesh hierarchy (who reports to whom) as a readable tree with status, host, harness/model, and current task.",
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
    name: "wake",
    description:
      "Nudge a downed teammate back. If you're UP and a peer is DOWN (killed by an API error / parked), don't wait on the mesh's slow auto-revive — wake them yourself, as often as you need. Pass `from` (your name) and a `target` to wake one peer, or omit `target` to wake EVERY peer that currently looks down. Code revival is just a backstop for when everyone is down; whoever's up should drive it.",
    inputSchema: { type: "object", properties: { from: NAME, target: NAME }, required: ["from"] },
    run: async (i) => {
      const r = await mesh.wakePeer(i.from as string, i.target as string | undefined);
      return r.woken.length
        ? `nudged ${r.woken.join(", ")} — they resume when their session picks it up; wake again if they stay quiet`
        : "no one to wake (nobody's currently down)";
    },
  },
  {
    name: "claim_resource",
    description:
      "Claim exclusive use of a NON-shareable resource BEFORE you drive it — an app port ('localhost:3722'), a browser tab ('chrome:pr-303'), a merge ('merge:#303'). Granted if it's free or already yours (re-claiming RENEWS the lease); errors with the current holder if someone else has it — then do NOT drive it, coordinate with the holder or wait. Auto-expires (default 15 min) so a crash never strands it; pass `ttl_sec` for longer and re-claim to renew. This is what stops two agents driving the same tab/port at once. Pass your `name`, the `resource` id, and an optional `note` (what you're doing with it).",
    inputSchema: { type: "object", properties: { name: NAME, resource: { type: "string" }, note: { type: "string" }, ttl_sec: { type: "number" } }, required: ["name", "resource"] },
    run: async (i) => { const { lease } = await mesh.claimResource(i.name as string, i.resource as string, i.note as string, i.ttl_sec as number); return `${lease.holder} holds "${lease.resource}" until ${new Date(lease.expires_at).toLocaleTimeString()}${lease.note ? ` — ${lease.note}` : ""}. Re-claim to renew; release_resource when done.`; },
  },
  {
    name: "release_resource",
    description: "Release a resource you claimed so others can drive it. Pass your `name` and the `resource` id. Leases auto-expire too, but release the moment you're done so no one waits needlessly.",
    inputSchema: { type: "object", properties: { name: NAME, resource: { type: "string" } }, required: ["name", "resource"] },
    run: async (i) => { const r = await mesh.releaseResource(i.name as string, i.resource as string); return r.released ? `released "${i.resource}"` : `you weren't holding "${i.resource}" (nothing to release)`; },
  },
  {
    name: "list_resources",
    description: "List the exclusive resources currently claimed (port / browser tab / merge) and who holds each, so you don't drive something someone else owns. Check this before driving any single-owner shared resource.",
    inputSchema: { type: "object", properties: {}, required: [] },
    run: async () => { const { leases } = await mesh.listLeases(); return leases.length ? leases.map((l) => `${l.resource} — ${l.holder}${l.note ? ` (${l.note})` : ""}, until ${new Date(l.expires_at).toLocaleTimeString()}`).join("\n") : "(no resources claimed)"; },
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
    name: "history",
    description:
      "Read the recent mesh conversation — EVERY message between all peers (not just your own inbox), oldest to newest, with who said what to whom. Use this to review or catch up on a whole run. Optional `limit` (default 50, max 200).",
    inputSchema: { type: "object", properties: { limit: { type: "number" } }, required: [] },
    run: async (i) => {
      const { messages } = await mesh.getHistory((i.limit as number) ?? 50);
      if (!messages.length) return "(no messages yet)";
      return messages
        .map((m) => {
          const to = m.recipients.length ? `→ ${m.recipients.join(", ")}` : "→ all";
          return `[${new Date(m.ts).toLocaleTimeString()}] ${m.sender} ${to}: ${m.content}`;
        })
        .join("\n");
    },
  },
  {
    name: "create_task",
    description: "Add a task to the board. ONE worker owner per task (managers coordinate, don't own leaves). Pass `assignee` to hand it to an EXISTING peer (check list_peers first; never invent one). `parent_num` makes it a subtask. `base` notes the PR/branch this stacks on (e.g. 'feat/x off #238') — data, not prose. `design: true` makes it a DESIGN task: spec it but DON'T build until a leader/operator locks it (moves it off 'design'); use this for anything where the binding decision isn't settled, to avoid building against a guess. Don't embed another task's number in the title.",
    inputSchema: { type: "object", properties: { title: { type: "string" }, detail: { type: "string" }, parent_num: { type: "number" }, assignee: NAME, creator: NAME, base: { type: "string" }, design: { type: "boolean" } }, required: ["title"] },
    run: async (i) => { const { task } = await mesh.createTask({ title: i.title as string, detail: i.detail as string, parentNum: i.parent_num as number, assignee: i.assignee as string, creator: i.creator as string, base: i.base as string, design: i.design as boolean }); return `created task #${task.num} "${task.title}"${task.status === "design" ? " [design — lock before building]" : ""}${task.parent_num ? ` under #${task.parent_num}` : ""}${task.assignee ? ` → @${task.assignee}` : " (backlog)"}${PLAIN_TITLE}`; },
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
    run: async (i) => { const { task } = await mesh.claimTask(i.name as string, i.num as number); return `${i.name} claimed #${task.num} "${task.title}"${PLAIN_STATUS}`; },
  },
  {
    name: "update_task",
    description: "Move a task (by num) to backlog | design | in_progress | blocked | done, with an optional result. Mark it `done` the MOMENT you finish (even if it still needs review — note that in the result); don't leave finished work in_progress. Moving a `design` task to in_progress = locking it for build. Pass your `name` so your presence follows the task.",
    inputSchema: { type: "object", properties: { num: { type: "number" }, status: { type: "string", enum: ["backlog", "design", "in_progress", "blocked", "done"] }, result: { type: "string" }, name: NAME }, required: ["num", "status"] },
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
    description: "Show the task board as a tree, with who's assigned, what's gated by what, and PR bases. Defaults to LIVE work only (done is hidden and summarized as a count). Use filter:done to see what's already BUILT (each shows its result) — check this before building so you don't rebuild existing work. Filter: live | all | backlog | design | active | assigned | in_progress | blocked | done.",
    inputSchema: { type: "object", properties: { filter: { type: "string" } }, required: [] },
    run: async (i) => {
      const filter = (i.filter as string) || "live"; // hide done by default so the board stays current
      const { tasks } = await mesh.listTasks(filter);
      const tree = renderTaskTree(tasks);
      if (!i.filter || filter === "live") {
        const done = (await mesh.listTasks("done")).tasks.length;
        return done ? `${tree}\n\n✓ ${done} done (list_tasks with filter:done to see them)` : tree;
      }
      return tree;
    },
  },
  {
    name: "create_artifact",
    description:
      "Publish a contract / decision / review / spec ONCE and get a handle (a<num>). Then reference it by handle in messages (e.g. 'gate string is a7') instead of re-pasting the whole body to every layer on every relay — this is the #1 way to cut coordination noise. `kind`: note | contract | decision | review | spec.",
    inputSchema: { type: "object", properties: { title: { type: "string" }, content: { type: "string" }, kind: { type: "string" }, creator: NAME }, required: ["title", "content"] },
    run: async (i) => { const { artifact } = await mesh.createArtifact({ title: i.title as string, content: i.content as string, kind: i.kind as string, creator: i.creator as string }); return `published ${artifact.handle} (${artifact.kind}) "${artifact.title}" — reference it as @${artifact.handle} instead of re-pasting`; },
  },
  {
    name: "get_artifact",
    description: "Read a published artifact by its handle (a<num> or @a<num>). Use this when someone references @a7 instead of pasting the body.",
    inputSchema: { type: "object", properties: { handle: { type: "string" } }, required: ["handle"] },
    run: async (i) => { const { artifact } = await mesh.getArtifact(i.handle as string); return `${artifact.handle} (${artifact.kind}) "${artifact.title}" by ${artifact.creator ?? "?"}:\n\n${artifact.content}`; },
  },
  {
    name: "update_artifact",
    description: "Revise a published artifact in place (by handle). Everyone referencing the handle now sees the new version — diff by handle instead of re-pasting full revisions.",
    inputSchema: { type: "object", properties: { handle: { type: "string" }, content: { type: "string" } }, required: ["handle", "content"] },
    run: async (i) => { const { artifact } = await mesh.updateArtifact(i.handle as string, i.content as string); return `updated ${artifact.handle} "${artifact.title}"`; },
  },
  {
    name: "list_artifacts",
    description: "List published artifacts (handle, kind, title) so you can reference one instead of restating it.",
    inputSchema: { type: "object", properties: {}, required: [] },
    run: async () => { const { artifacts } = await mesh.listArtifacts(); return artifacts.length ? artifacts.map((a) => `${a.handle} [${a.kind}] ${a.title}`).join("\n") : "(no artifacts yet)"; },
  },
  {
    name: "delete_artifact",
    description: "Permanently delete a published artifact by handle (a<num> or @a<num>). Use when a doc is obsolete or superseded and just taking up space — references to it 404 afterward. Stale artifacts also auto-expire on their own, so only delete when you want it gone now.",
    inputSchema: { type: "object", properties: { handle: { type: "string" } }, required: ["handle"] },
    run: async (i) => { await mesh.deleteArtifact(i.handle as string); return `deleted ${String(i.handle).replace(/^@/, "")}`; },
  },
];

export const TOOLS_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));
