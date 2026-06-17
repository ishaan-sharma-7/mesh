import { cookies } from "next/headers";
import { codeOk, COOKIE } from "@/lib/auth";
import Login from "@/components/Login";
import Dashboard from "@/components/Dashboard";

export const dynamic = "force-dynamic";

export default async function Home() {
  const code = (await cookies()).get(COOKIE)?.value;
  return codeOk(code) ? <Dashboard /> : <Login />;
}
