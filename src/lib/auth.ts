// One shared secret gates everything: the MCP endpoint checks it as a Bearer
// token, the website checks it as a login. Whoever has MESH_CODE is in.

import { timingSafeEqual } from "node:crypto";

// The cookie the website uses to remember a logged-in browser.
export const COOKIE = "mesh_code";

export function meshCode(): string {
  const code = process.env.MESH_CODE;
  if (!code) throw new Error("MESH_CODE is not set");
  return code;
}

export function bearerOk(authHeader: string | null): boolean {
  if (!authHeader) return false;
  const m = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
  const token = m ? m[1] : authHeader.trim();
  return safeEqual(token, meshCode());
}

export function codeOk(code: string | null | undefined): boolean {
  return !!code && safeEqual(code, meshCode());
}

// Constant-time compare on the contents so we don't leak the code via timing.
// (Length can still differ — unavoidable without padding — but the secret is a
// long random token, so its length isn't the useful part to an attacker.)
function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}
