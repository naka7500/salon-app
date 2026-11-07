"use client";
// 本番（Supabase）モードのときだけログインを必須にする。デモモードはそのまま通す。
// 仮パスワードで入った人（app_metadata.must_change_password）は、自分のパスワードを決めるまで先に進めない。
import { useEffect, useState } from "react";
import { getRepo } from "@/lib/db";
import { MIN_PASSWORD, checkNewPassword } from "@/lib/staffLogin";

type Phase = "checking" | "login" | "change" | "ok";
type SessionLike = { user?: { email?: string | null; app_metadata?: Record<string, unknown> } } | null;
const mustChange = (s: SessionLike) => s?.user?.app_metadata?.must_change_password === true;

export default function AuthGate({ children }: { children: React.ReactNode }) {
  const [phase, setPhase] = useState<Phase>("checking");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [pw1, setPw1] = useState("");
  const [pw2, setPw2] = useState("");
  const [myEmail, setMyEmail] = useState("");
  const [demo, setDemo] = useState(false);
  const leaveDemo = () => { location.href = location.pathname; };

  useEffect(() => {
    if (getRepo().mode !== "supabase") {
      // デモだけ：ログイン画面・パスワード変更画面の見本（?demo_login=login / change）。本物のログインはしない
      let d = ""; try { d = new URLSearchParams(location.search).get("demo_login") || ""; } catch {}
      void Promise.resolve().then(() => {
        if (d === "login" || d === "change") { setDemo(true); setEmail("store+takesue@gmail.com"); setMyEmail("store+takesue@gmail.com"); setPhase(d); }
        else setPhase("ok");
      });
      return;
    }
    // QR・リンクで開いたときはメールを入れておく（/bookings?email=...）
    try { const e = new URLSearchParams(location.search).get("email"); if (e) void Promise.resolve().then(() => setEmail(e.slice(0, 254))); } catch {}
    let unsub = () => {};
    (async () => {
      const { sb } = await import("@/lib/db/supabase");
      const { data } = await sb().auth.getSession();
      if (data.session && mustChange(data.session)) { setMyEmail(data.session.user.email || ""); setPhase("change"); }
      else if (data.session) { await claim(); await ready(); } else setPhase("login");
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
    e.preventDefault();
    if (demo) { leaveDemo(); return; }
    setBusy(true); setErr("");
    const { sb } = await import("@/lib/db/supabase");
    const { error } = await sb().auth.signInWithPassword({ email: email.trim(), password });
    setBusy(false);
    if (error) {
      const banned = /banned/i.test(error.message) || (error as { code?: string }).code === "user_banned";
      setErr(banned ? "このログインは止められています。店長・オーナーに連絡してください" : /rate|many/i.test(error.message) ? "回数が多すぎます。少し待ってからもう一度どうぞ" : "メールアドレスかパスワードが違います");
      return;
    }
    await claim();
    location.reload();
  }

  async function changePw(e: React.FormEvent) {
    e.preventDefault(); setErr("");
    const bad = checkNewPassword(pw1, myEmail);
    if (bad) { setErr(bad); return; }
    if (pw1 !== pw2) { setErr("確認のパスワードが一致しません"); return; }
    if (demo) { leaveDemo(); return; }
    setBusy(true);
    try { await getRepo().changeOwnPassword(pw1); setPw1(""); setPw2(""); await claim(); location.reload(); }
    catch (x) { setErr((x as Error).message); setBusy(false); }
  }

  if (phase === "checking") return <div className="p-10 text-center text-stone-500">読み込み中…</div>;
  if (phase === "login") return (
    <div className="min-h-screen flex items-center justify-center bg-stone-50 p-4">
      <form onSubmit={login} className="w-full max-w-sm bg-white rounded-xl shadow p-6 space-y-4">
        {demo && <div className="chip bg-amber-400 text-stone-900 font-bold">デモ：画面の見本です</div>}
        <h1 className="text-lg font-bold text-canopy">サロン台帳 ログイン</h1>
        <label className="block text-sm">メールアドレス
          <input type="email" autoComplete="username" required value={email} onChange={e => setEmail(e.target.value)} className="inp mt-1 w-full min-h-11 !text-[16px]" />
        </label>
        <label className="block text-sm">パスワード
          <input type="password" autoComplete="current-password" required value={password} onChange={e => setPassword(e.target.value)} className="inp mt-1 w-full min-h-11 !text-[16px]" />
        </label>
        {err && <p className="text-sm text-red-600">{err}</p>}
        <button disabled={busy} className="btn-primary w-full">{busy ? "確認中…" : "ログイン"}</button>
        <p className="text-xs text-stone-500">ログインはオーナーが 設定＞スタッフ で発行します。パスワードを忘れたときはオーナーに「パスワードの再設定」を頼んでください。</p>
      </form>
    </div>
  );
  if (phase === "change") return (
    <div className="min-h-screen flex items-center justify-center bg-paper p-4">
      <form onSubmit={changePw} noValidate className="w-full max-w-sm bg-white rounded-[var(--radius-sheet)] border border-line shadow p-6 space-y-4" data-testid="change-password">
        {demo && <div className="chip bg-amber-400 text-stone-900 font-bold">デモ：画面の見本です</div>}
        <h1 className="text-lg font-bold text-canopy">自分のパスワードを決めてください</h1>
        <p className="text-sm text-ink-soft">今は仮パスワードでログインしています。自分だけが知っているパスワード（{MIN_PASSWORD}文字以上）に変えると、いつもの画面が開きます。</p>
        {myEmail && <p className="text-xs text-ink-mute">ログイン中：<span className="font-mono">{myEmail}</span></p>}
        <label className="block text-sm">新しいパスワード（{MIN_PASSWORD}文字以上）
          <input type="password" autoComplete="new-password" required minLength={MIN_PASSWORD} value={pw1} onChange={e => setPw1(e.target.value)} className="inp mt-1 w-full min-h-11 !text-[16px]" />
        </label>
        <label className="block text-sm">もう一度（確認）
          <input type="password" autoComplete="new-password" required minLength={MIN_PASSWORD} value={pw2} onChange={e => setPw2(e.target.value)} className="inp mt-1 w-full min-h-11 !text-[16px]" />
        </label>
        <p className="text-[11px] text-ink-mute">スマホ・iPad の「パスワードを保存」を使うと次から楽です。誕生日・電話番号・店の名前だけ、は避けてください。</p>
        {err && <p className="text-sm text-danger">{err}</p>}
        <button disabled={busy} className="btn-primary w-full">{busy ? "保存中…" : "このパスワードにする"}</button>
        <button type="button" className="btn-quiet w-full" onClick={demo ? leaveDemo : logout}>やめてログアウト</button>
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
