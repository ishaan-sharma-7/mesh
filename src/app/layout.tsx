import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "mesh",
  description: "A tiny self-hosted mesh for Claude agents: peers, a task tree, and a live dashboard.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
