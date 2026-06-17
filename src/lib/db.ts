import postgres from "postgres";

// One pooled client, created lazily on first query and reused across serverless
// invocations. Lazy so importing this module during `next build` (which has no
// DATABASE_URL) never throws — the client is only built when a query runs.
declare global {
  // eslint-disable-next-line no-var
  var __clmesh_sql: postgres.Sql | undefined;
}

function make(): postgres.Sql {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  // No SSL on local Postgres or Railway's private network (*.railway.internal),
  // where traffic is already isolated and the server doesn't offer SSL. Require
  // it for any public host (Railway public proxy, Supabase, Neon, …).
  const noSsl = /localhost|127\.0\.0\.1|\.railway\.internal/.test(url);
  return postgres(url, {
    // Supabase's transaction pooler can't do prepared statements; off everywhere.
    prepare: false,
    ssl: noSsl ? false : "require",
    idle_timeout: 20,
    max: 5,
  });
}

function get(): postgres.Sql {
  if (!globalThis.__clmesh_sql) globalThis.__clmesh_sql = make();
  return globalThis.__clmesh_sql;
}

// A proxy that defers construction until the first call/property access.
export const sql = new Proxy((() => {}) as unknown as postgres.Sql, {
  apply(_t, _this, args: unknown[]) {
    // Tagged-template call: sql`...`
    return (get() as unknown as (...a: unknown[]) => unknown)(...args);
  },
  get(_t, prop: string | symbol) {
    const s = get() as unknown as Record<string | symbol, unknown>;
    const v = s[prop];
    return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(s) : v;
  },
}) as postgres.Sql;
