import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

// The dashboard is the static org-chart page in /public (board.html). It does
// its own code login against /api/auth and reads /api/mesh/state, so the root
// just bounces to it.
export default function Home() {
  redirect("/board.html");
}
