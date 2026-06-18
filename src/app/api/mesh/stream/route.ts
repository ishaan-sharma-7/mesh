// The live stream a peer subscribes to. Holds an SSE connection open and pushes
// every message addressed to this peer (direct or broadcast) the instant it's
// written — driven by Postgres NOTIFY, no polling. Holding the connection open
// also IS the peer's heartbeat: we bump last_seen while it's connected. Railway
// runs a persistent server, so a long-lived SSE response stays open.

import { NextRequest } from "next/server";
import { bearerOk } from "@/lib/auth";
import { ensureListening, messageBus, type BusMessage } from "@/lib/bus";
import { sql } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (!bearerOk(req.headers.get("authorization"))) {
    return new Response("unauthorized", { status: 401 });
  }
  const name = req.nextUrl.searchParams.get("name");
  if (!name) return new Response("name required", { status: 400 });

  try {
    await ensureListening();
  } catch {
    return new Response("listener unavailable", { status: 503 });
  }

  const enc = new TextEncoder();
  const touch = () => {
    sql`update peers set last_seen = now() where name = ${name}`.catch(() => {});
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const safeEnqueue = (s: string) => {
        try {
          controller.enqueue(enc.encode(s));
        } catch {
          /* stream already closed */
        }
      };
      safeEnqueue(": connected\n\n");
      touch(); // online the moment we connect

      const onMessage = (m: BusMessage) => {
        const rec = m.recipients ?? [];
        if (m.sender === name) return; // never echo your own
        if (rec.length && !rec.includes(name)) return; // not for you, not a broadcast
        safeEnqueue(`data: ${JSON.stringify(m)}\n\n`);
      };
      messageBus.on("message", onMessage);

      const keepalive = setInterval(() => safeEnqueue(": keepalive\n\n"), 20000);
      const heartbeat = setInterval(touch, 30000); // stay online while connected

      const close = () => {
        messageBus.off("message", onMessage);
        clearInterval(keepalive);
        clearInterval(heartbeat);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      req.signal.addEventListener("abort", close);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
