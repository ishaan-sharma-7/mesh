"use client";

import { useState } from "react";

export default function Login() {
  const [code, setCode] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr("");
    const res = await fetch("/api/auth", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
    });
    if (res.ok) window.location.reload();
    else {
      setErr("That code didn't work.");
      setBusy(false);
    }
  }

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={submit}>
        <h1>mesh</h1>
        <p>Enter the mesh code to watch and steer the mesh.</p>
        <input
          autoFocus
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="mesh code"
          type="password"
        />
        <button className="primary" disabled={busy || !code}>
          {busy ? "checking…" : "Enter"}
        </button>
        {err && <div className="err">{err}</div>}
      </form>
    </div>
  );
}
