"use client";
// 本番（Supabase）モードのときだけログインを必須にする。デモモードはそのまま通す。
import { useEffect, useState } from "react";
import { getRepo } from "@/lib/db";

type Phase = "checking" | "login" | "ok";

export default function AuthGate({ children }: { children: React.ReactNode }) {
  const [phase, setPhase] = useState<Phase>("checking");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (getRepo().mode !== "supabase") { setPhase("ok"); return; }
    let unsub = () => {};
    (async () => {
      const { sb } = await import("@/lib/db/supabase");
      const { data } = await sb().auth.getSession();
      if (data.session) { await claim(); await ready(); } else setPhase("login");
      const { data: sub } = sb().auth.onAuthStateChange((_e, s) => { if (!s) setPhase("login"); });
      unsub = () => sub.subscription.unsubscribe();
    })();
    return () => unsub();
  }, []);

  async function claim() {
    // ログインしたメールアドレスと同じ staff 行に auth_user_id を紐づける（初回だけ効く）
    const { sb } = await import("@/lib/db/supabase");
    await sb().rpc("claim_staff");
  }

  async function ready() {
    const { initStore } = await import("@/lib/db/supabase");
    const n = await initStore();
    if (n === 0) { setErr("このアカウントで見られる店舗がありません。管理者に確認してください。"); setPhase("login"); return; }
    setPhase("ok");
  }

  async function login(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setErr("");
    const { sb } = await import("@/lib/db/supabase");
    const { error } = await sb().auth.signInWithPassword({ email: email.trim(), password });
    setBusy(false);
    if (error) { setErr("メールアドレスかパスワードが違います"); return; }
    await claim();
    location.reload();
  }

  if (phase === "checking") return <div className="p-10 text-center text-stone-500">読み込み中…</div>;
  if (phase === "login") return (
    <div className="min-h-screen flex items-center justify-center bg-stone-50 p-4">
      <form onSubmit={login} className="w-full max-w-sm bg-white rounded-xl shadow p-6 space-y-4">
        <h1 className="text-lg font-bold text-[#2f6b4f]">サロン台帳 ログイン</h1>
        <label className="block text-sm">メールアドレス
          <input type="email" autoComplete="username" required value={email} onChange={e => setEmail(e.target.value)} className="mt-1 w-full border rounded px-3 py-2" />
        </label>
        <label className="block text-sm">パスワード
          <input type="password" autoComplete="current-password" required value={password} onChange={e => setPassword(e.target.value)} className="mt-1 w-full border rounded px-3 py-2" />
        </label>
        {err && <p className="text-sm text-red-600">{err}</p>}
        <button disabled={busy} className="w-full bg-[#2f6b4f] text-white rounded py-2 font-semibold disabled:opacity-50">{busy ? "確認中…" : "ログイン"}</button>
        <p className="text-xs text-stone-500">アカウントは管理者が発行します。</p>
      </form>
    </div>
  );
  return <>{children}</>;
}

export async function logout() {
  const { sb } = await import("@/lib/db/supabase");
  await sb().auth.signOut();
  location.reload();
}
