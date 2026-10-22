import { useState } from "react";
import type { LoginResult } from "../../lib/adminClient";

const MESSAGES: Record<Exclude<LoginResult, "ok">, string> = {
  invalid: "Log masuk gagal. Nama pengguna atau kata laluan salah.",
  // 5 attempts/min/IP at the API, plus the zone-wide rule. Retrying inside the
  // block only extends it, so the message has to say "wait", not "try again".
  "rate-limited": "Terlalu banyak cubaan log masuk. Tunggu seminit, kemudian cuba lagi.",
  error: "Log masuk gagal kerana masalah rangkaian. Cuba lagi.",
};

export function AdminLogin({ onLogin }: { onLogin: (username: string, password: string) => Promise<LoginResult> }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<Exclude<LoginResult, "ok"> | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <div>
      <h2>Admin</h2>
      <label htmlFor="username">Nama Pengguna</label>
      <input id="username" value={username} onChange={(e) => setUsername(e.target.value)} />
      <label htmlFor="password">Kata Laluan</label>
      <input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
      {error && <p>{MESSAGES[error]}</p>}
      <button
        disabled={busy}
        onClick={async () => {
          // One attempt per tap: each POST costs one of the 5/min allowance.
          if (busy) return;
          setBusy(true);
          setError(null);
          try {
            const result = await onLogin(username, password);
            if (result !== "ok") setError(result);
          } catch (err) {
            console.error("login failed:", err);
            setError("error");
          } finally {
            setBusy(false);
          }
        }}
      >
        Log Masuk
      </button>
    </div>
  );
}
