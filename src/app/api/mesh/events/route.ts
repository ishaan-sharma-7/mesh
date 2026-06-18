// The dashboard's live wire. Holds an SSE connection open and pushes a "ping"
// the instant anything changes on the mesh (a message, a status/task change, a
// peer joining or leaving) so the dashboard redraws in well under a second —
// no polling. Gated by the mesh-code cookie, same as the rest of the dashboard.

import { NextRequest } from "next/server";
import { codeOk, COOKIE } from "@/lib/auth";
import { ensureListening, messageBus } from "@/lib/bus";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (!codeOk(req.cookies.get(COOKIE)?.value)) {
    return new Response("unauthorized", { status: 401 });
  }
  try {
    await ensureListening();
  } catch {
    return new Response("listener unavailable", { status: 503 });
  }

  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const push = (s: string) => {
        try {
          controller.enqueue(enc.encode(s));
        } catch {
          /* closed */
        }
      };
      push(": connected\n\n");
      const ping = () => push(`data: ${Date.now()}\n\n`);
      messageBus.on("message", ping);
      messageBus.on("change", ping);
      const keepalive = setInterval(() => push(": keepalive\n\n"), 20000);

      req.signal.addEventListener("abort", () => {
        messageBus.off("message", ping);
        messageBus.off("change", ping);
        clearInterval(keepalive);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      });
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
