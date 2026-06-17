// Runs once when the server process starts (Railway keeps it alive, unlike
// serverless). Two jobs:
//   1. apply the schema, so a fresh Postgres is ready with no manual step,
//   2. start the idle-peer reaper on an interval, replacing the cron we'd
//      need on a serverless host.
// Next calls register() at boot for each runtime; we only want the Node one.

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { sql } = await import("./lib/db");
  const { SCHEMA } = await import("./lib/schema");
  const { reap } = await import("./lib/mesh");

  try {
    await sql.unsafe(SCHEMA);
    console.log("[mesh] schema applied");
  } catch (e) {
    console.error("[mesh] schema apply failed:", (e as Error).message);
  }

  // Sweep idle peers (>1h) back off the mesh and free their tasks. The on-read
  // sweep already covers active periods; this catches a fully idle mesh.
  const REAP_EVERY_MS = 5 * 60 * 1000;
  const g = globalThis as { __mesh_reaper?: ReturnType<typeof setInterval> };
  if (!g.__mesh_reaper) {
    g.__mesh_reaper = setInterval(() => {
      reap().catch((e) => console.error("[mesh] reap failed:", (e as Error).message));
    }, REAP_EVERY_MS);
    console.log("[mesh] reaper started");
  }
}
