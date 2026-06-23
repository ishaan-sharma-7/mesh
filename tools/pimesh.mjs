#!/usr/bin/env node
// Launch Pi as a mesh-enabled coding agent.
//
// This is the Pi equivalent of the Claude Code `mesh` shell alias:
// it starts `pi` with this repo loaded as a Pi package, so the
// `.pi/extensions/mesh.ts` bridge registers mesh MCP tools and opens the live
// mesh channel stream.

import { accessSync, constants, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);

function hasMeshConfig() {
  if (process.env.MESH_CODE) return true;
  try {
    const cfg = JSON.parse(readFileSync(resolve(homedir(), ".mesh", "mcp.json"), "utf8"));
    return Boolean(cfg?.mcpServers?.mesh?.headers?.Authorization || cfg?.code);
  } catch {
    return false;
  }
}

function findPi() {
  for (const candidate of [
    process.env.PI_BIN,
    "/opt/homebrew/bin/pi",
    "/usr/local/bin/pi",
    "pi",
  ].filter(Boolean)) {
    if (candidate === "pi") return candidate;
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // keep looking
    }
  }
  return "pi";
}

if (!hasMeshConfig()) {
  console.error("pimesh: missing MESH_CODE or ~/.mesh/mcp.json with mcpServers.mesh Authorization.");
  console.error("Create ~/.mesh/mcp.json the same way the Claude Code mesh plugin uses it, then retry.");
  process.exit(2);
}

const env = {
  ...process.env,
  // Homebrew's global pi currently requires Node >=22.19. Keep the modern
  // Homebrew node first without clobbering the rest of the user's PATH.
  PATH: ["/opt/homebrew/bin", process.env.PATH || ""].filter(Boolean).join(":"),
};

const child = spawnSync(findPi(), ["-e", root, ...args], {
  stdio: "inherit",
  env,
});

if (child.error) {
  console.error(`pimesh: failed to launch pi: ${child.error.message}`);
  process.exit(1);
}
process.exit(child.status ?? 0);
