import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The MCP route streams JSON-RPC; keep it on the Node runtime.
  serverExternalPackages: ["postgres"],
};

export default nextConfig;
