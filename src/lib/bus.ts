// Server-push backbone. Two Postgres NOTIFY channels feed one in-process bus:
//   - mesh_message: a peer-addressed message (sendMessage) -> bus "message"
//   - mesh_change:  any state change worth redrawing a dashboard (status, task,
//                   peer join/leave) -> bus "change"
// SSE routes subscribe to the bus and push to connected clients instantly, no
// polling. NOTIFY reaches every server instance, so this works multi-replica.

import { EventEmitter } from "node:events";
import { sql } from "./db";

export const CHANNEL = "mesh_message";
export const CHANGE = "mesh_change";

export const messageBus = new EventEmitter();
messageBus.setMaxListeners(0); // one listener per open SSE connection

export type BusMessage = { id: number; sender: string; recipients: string[]; content: string };

declare global {
  // eslint-disable-next-line no-var
  var __mesh_listening: Promise<void> | undefined;
}

// Start the LISTEN connections once per process. Idempotent.
export function ensureListening(): Promise<void> {
  if (!globalThis.__mesh_listening) {
    globalThis.__mesh_listening = Promise.all([
      sql.listen(CHANNEL, (payload) => {
        try {
          messageBus.emit("message", JSON.parse(payload) as BusMessage);
        } catch {
          /* ignore malformed payloads */
        }
      }),
      sql.listen(CHANGE, () => messageBus.emit("change")),
    ])
      .then(() => undefined)
      .catch((e) => {
        globalThis.__mesh_listening = undefined; // let a later request retry
        throw e;
      });
  }
  return globalThis.__mesh_listening;
}

// Fire a "something changed" ping so any open dashboard stream redraws. Cheap
// and best-effort; callers don't await it.
export async function notifyChange(): Promise<void> {
  try {
    await sql`select pg_notify(${CHANGE}, '')`;
  } catch {
    /* best-effort */
  }
}
