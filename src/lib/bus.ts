// Server-push backbone. sendMessage fires a Postgres NOTIFY when a message is
// written; this module holds ONE LISTEN connection that re-emits every NOTIFY
// onto an in-process EventEmitter. The SSE stream route subscribes to that
// emitter and pushes matching messages to each connected peer instantly — no
// polling. NOTIFY reaches every server instance that's listening, so this also
// works if Railway ever runs more than one replica.

import { EventEmitter } from "node:events";
import { sql } from "./db";

export const CHANNEL = "mesh_message";

export const messageBus = new EventEmitter();
messageBus.setMaxListeners(0); // one listener per open SSE connection

export type BusMessage = { id: number; sender: string; recipients: string[]; content: string };

declare global {
  // eslint-disable-next-line no-var
  var __mesh_listening: Promise<void> | undefined;
}

// Start the single LISTEN connection once per process. Idempotent.
export function ensureListening(): Promise<void> {
  if (!globalThis.__mesh_listening) {
    globalThis.__mesh_listening = sql
      .listen(CHANNEL, (payload) => {
        try {
          messageBus.emit("message", JSON.parse(payload) as BusMessage);
        } catch {
          /* ignore malformed payloads */
        }
      })
      .then(() => undefined)
      .catch((e) => {
        // Let a later request retry by clearing the cached promise.
        globalThis.__mesh_listening = undefined;
        throw e;
      });
  }
  return globalThis.__mesh_listening;
}
