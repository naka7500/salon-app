"use client";
// 設定＞スタッフ「ログインの発行」：状態のバッジ・編集画面のログイン欄・仮パスワードの表示（1回だけ）・操作の記録。
// 仮パスワードはこの画面の state にだけ置き、閉じたら消す（保存・送信・ログ出力しない）。
import { useEffect, useState } from "react";
import type { Staff, StaffLoginInfo, StaffLoginResult, StaffLoginStatusResult, LoginStatus } from "@/lib/db";
import { ACTION_JA, LOGIN_STATUS_LABEL, isValidEmail, loginPermissionError, normalizeEmail, plusAddress, type StaffLoginHistory } from "@/lib/staffLogin";

const BADGE: Record<LoginStatus, string> = {
  none: "bg-stone-100 text-stone-600",
  invited: "bg-sun-soft text-[#7a4f12] border border-[#ecd3a5]",
  active: "bg-emerald-100 text-emerald-800",
  stopped: "bg-rose-100 text-rose-800",
};
export function LoginBadge({ info, fallback }: { info?: StaffLoginInfo; fallback?: Staff }) {
  const st: LoginStatus | null = info?.status ?? (fallback ? (fallback.auth_user_id ? "active" : null) : null);
  if (!st) return null;
  return <span className={`px-1.5 rounded ${BADGE[st]}`} data-testid="login-badge">ログイン：{LOGIN_STATUS_LABEL[st]}</span>;
}

type Act = (kind: "issue" | "invite" | "reset" | "stop" | "resume", extra?: { email?: string; link_existing?: boolean }) => Promise<StaffLoginResult | null>;

/** 編集画面のログイン欄 */
export function LoginPanel({ staff, info, status, me, storeEmail, act, busy }: {
  staff: Staff & { id: string }; info?: StaffLoginInfo; status: StaffLoginStatusResult | null; me: Staff | null | undefined; storeEmail?: string | null; act: Act; busy: boolean;
}) {
  const st: LoginStatus = info?.status ?? (staff.auth_user_id ? "active" : "none");
  const [email, setEmail] = useState(info?.email || staff.email || "");
  const [exists, setExists] = useState(false);
  useEffect(() => { void Promise.resolve().then(() => { setEmail(info?.email || staff.email || ""); setExists(false); }); }, [staff.id, info?.email, staff.email]);
  const actor = { staff_id: me?.id ?? null, auth_user_id: me?.auth_user_id ?? null, role: me?.role };
  const can = (k: Parameters<typeof loginPermissionError>[0]) => !loginPermissionError(k, actor, staff);
  const why = (k: Parameters<typeof loginPermissionError>[0]) => loginPermissionError(k, actor, staff);
  const server = !!status?.server;
  const suggestion = plusAddress(storeEmail, staff.name_en);
  const emailOk = isValidEmail(normalizeEmail(email));

  async function issue(link_existing?: boolean) {
    const r = await act("issue", { email: normalizeEmail(email), link_existing });
    if (r && !r.ok && r.code === "email_exists") setExists(true); else setExists(false);
  }

  return (
    <div className="mt-4 pt-3 border-t text-sm" data-testid="login-panel">
      <div className="flex flex-wrap items-center gap-2 mb-2">
        <div className="font-semibold">ログイン</div>
        <span className={`text-[11px] px-1.5 rounded ${BADGE[st]}`} data-testid="login-status">{LOGIN_STATUS_LABEL[st]}</span>
        {info?.email && <span className="font-mono text-xs text-ink-soft break-all">{info.email}</span>}
        {status?.demo && <span className="chip bg-amber-400 text-stone-900 font-bold">デモ</span>}
      </div>
      {!status && <div className="text-xs text-ink-mute">読み込み中…</div>}
      {status && !server && (
        <div className="text-xs px-3 py-2 rounded bg-amber-50 border border-amber-300 text-amber-900">
          サーバの設定（Vercel の環境変数 <span className="font-mono">SUPABASE_SERVICE_ROLE_KEY</span>）がまだのため、この画面からはログインの発行・停止ができません。
          {staff.email ? <> 今のメール：<span className="font-mono">{staff.email}</span>{staff.auth_user_id ? "（ログイン済み）" : "（まだログインしていない）"}</> : null}
        </div>
      )}
      {server && st === "none" && (
        can("issue") ? (
          <div className="space-y-2">
            <label className="block"><span className="lbl">このスタッフのメールアドレス（ログインのID）</span>
              <input type="email" inputMode="email" autoComplete="off" className="inp w-full min-h-11" placeholder="例：takesue@example.com" value={email} onChange={e => { setEmail(e.target.value); setExists(false); }} data-testid="login-email" />
            </label>
            <div className="text-[11px] text-ink-soft leading-relaxed bg-paper border border-line rounded px-2 py-1.5">
              自分のメールが無い・教えたくないスタッフは、<b>お店のGmailに「＋名前」を付けたアドレス</b>が使えます（例：<span className="font-mono">store+takesue@gmail.com</span>）。届くメールはお店のGmailに入ります。
              {suggestion && <> <button type="button" className="underline text-canopy ml-1" onClick={() => setEmail(suggestion)}>{suggestion} を入れる</button></>}
            </div>
            {exists && (
              <div className="text-xs px-3 py-2 rounded bg-amber-50 border border-amber-300 text-amber-900 space-y-1.5">
                <div>このメールのログインはもうあります（別の会社・店舗で使っている等）。</div>
                <div className="flex flex-wrap gap-2"><button type="button" className="btn" disabled={busy} onClick={() => issue(true)}>今のログインをこのスタッフにもつなぐ</button><button type="button" className="btn-quiet" onClick={() => { setExists(false); setEmail(""); }}>別のメールにする</button></div>
              </div>
            )}
            <div className="flex flex-wrap gap-2">
              <button type="button" className="btn-primary" disabled={busy || !emailOk} onClick={() => issue()} data-testid="login-issue">ログインを発行</button>
              {status?.invite_enabled && <button type="button" className="btn" disabled={busy || !emailOk} onClick={() => act("invite", { email: normalizeEmail(email) })}>招待メールを送る</button>}
            </div>
            <div className="text-[11px] text-ink-mute">「発行」すると仮パスワードが1回だけ表示されます。本人に伝えて、最初のログインで自分のパスワードに変えてもらいます。{!status?.invite_enabled && "（招待メールは、メールの送信設定をした後に使えます。Supabase 標準のメールは1時間に数通までなので、仮パスワードの方が確実です）"}</div>
          </div>
        ) : <div className="text-xs text-ink-mute">まだログインはありません。{why("issue")}</div>
      )}
      {server && st !== "none" && (
        <div className="space-y-2">
          <div className="text-xs text-ink-soft">
            {st === "invited" && "発行済み。本人がまだ最初のログイン（自分のパスワードに変更）をしていません。"}
            {st === "active" && <>ログインできます。{info?.last_sign_in_at && <>最後のログイン：{new Date(info.last_sign_in_at).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</>}</>}
            {st === "stopped" && "ログインは止まっています（この人はログインできません）。"}
          </div>
          <div className="flex flex-wrap gap-2">
            {st !== "stopped" && can("reset") && <button type="button" className="btn" disabled={busy} onClick={() => { if (confirm(`${staff.name}さんのパスワードを再設定しますか？\n新しい仮パスワードを表示します。今ログインしている端末はログアウトされます。`)) void act("reset"); }} data-testid="login-reset">パスワードを再設定</button>}
            {st !== "stopped" && can("stop") && <button type="button" className="btn text-danger" disabled={busy} onClick={() => { if (confirm(`${staff.name}さんのログインを止めますか？\nすぐにログインできなくなります（データは消えません）。`)) void act("stop"); }} data-testid="login-stop">ログインを止める</button>}
            {st === "stopped" && can("resume") && <button type="button" className="btn" disabled={busy} onClick={() => void act("resume")} data-testid="login-resume">再開</button>}
          </div>
          {st !== "stopped" && !can("reset") && <div className="text-[11px] text-ink-mute">{why("reset")}</div>}
          {st === "stopped" && !can("resume") && <div className="text-[11px] text-ink-mute">{why("resume")}</div>}
        </div>
      )}
    </div>
  );
}

/** 仮パスワードの表示（この1回だけ）。QR はログイン画面のURL（メール入り） */
export function TempPasswordSheet({ r, name, onClose }: { r: StaffLoginResult; name: string; onClose: () => void }) {
  const [qr, setQr] = useState<string>("");
  const [copied, setCopied] = useState("");
  useEffect(() => {
    let on = true;
    if (r.login_url) import("qrcode").then(Q => Q.toDataURL(r.login_url!, { errorCorrectionLevel: "M", margin: 1, width: 280 })).then(u => { if (on) setQr(u); }).catch(() => {});
    return () => { on = false; };
  }, [r.login_url]);
  async function copy(text: string, what: string) {
    try { await navigator.clipboard.writeText(text); setCopied(what); setTimeout(() => setCopied(""), 2000); } catch { setCopied("コピーできませんでした（長押しで選んでください）"); }
  }
  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-end sm:items-center justify-center" role="dialog" aria-label="仮パスワード">
      <div className="bg-white w-full sm:max-w-md rounded-t-xl sm:rounded-xl p-4 max-h-[94vh] overflow-auto" data-testid="temp-sheet">
        <div className="flex items-center gap-2 mb-2">
          <h2 className="font-bold">{name}さんのログイン</h2>
          {r.demo && <span className="chip bg-amber-400 text-stone-900 font-bold">デモ</span>}
        </div>
        <div className="text-sm px-3 py-2 rounded bg-sun-soft border border-[#ecd3a5] text-[#5b3a0c] mb-3">この仮パスワードは<b>今この画面でだけ</b>表示されます。閉じると二度と見られません（忘れたら「パスワードを再設定」）。</div>
        <dl className="space-y-3">
          <div><dt className="lbl">メールアドレス（ID）</dt><dd className="flex items-center gap-2"><span className="font-mono text-sm break-all flex-1">{r.email}</span><button className="btn" onClick={() => copy(r.email || "", "メール")}>コピー</button></dd></div>
          <div><dt className="lbl">仮パスワード{r.demo ? "（デモ・本物ではありません）" : ""}</dt>
            <dd className="flex items-center gap-2"><span className="font-mono text-2xl tracking-wider flex-1 select-all" data-testid="temp-password">{r.temp_password}</span><button className="btn-primary" onClick={() => copy(r.temp_password || "", "仮パスワード")}>コピー</button></dd></div>
          {r.login_url && <div><dt className="lbl">ログインの画面（スマホのカメラで読む）</dt>
            <dd className="flex items-center gap-3">{qr ? <img src={qr} alt="ログイン画面のQR" className="w-32 h-32 border border-line rounded" /> : <div className="w-32 h-32 bg-paper rounded" />}
              <div className="flex-1 min-w-0 space-y-1"><div className="font-mono text-[11px] break-all text-ink-soft">{r.login_url}</div><button className="btn" onClick={() => copy(r.login_url || "", "URL")}>URLをコピー</button></div></dd></div>}
        </dl>
        {copied && <div className="text-xs text-emerald-700 mt-2">{copied}をコピーしました</div>}
        <div className="text-xs text-ink-soft mt-3 leading-relaxed">本人に伝えること：①QRを読む（またはURLを開く）②メールと仮パスワードでログイン ③自分のパスワード（10文字以上）を決める ④Safari の共有ボタン→「ホーム画面に追加」。<br />LINE・メールで送る場合は、メールアドレスと仮パスワードを<b>別々のメッセージ</b>にしてください。</div>
        <button className="btn-primary w-full mt-4" onClick={onClose} data-testid="temp-close">本人に伝えました（閉じる）</button>
      </div>
    </div>
  );
}

export function LoginHistoryList({ list }: { list?: StaffLoginHistory[] }) {
  if (!list?.length) return null;
  return (
    <details className="card mt-3 text-sm">
      <summary className="cursor-pointer font-semibold">ログインの操作の記録（最近{list.length}件）</summary>
      <ul className="mt-2 divide-y divide-line">
        {list.map((h, i) => <li key={i} className="py-1.5 flex flex-wrap gap-x-2 text-xs"><span className="text-ink-mute tabular-nums">{new Date(h.at).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span><span className="font-semibold">{h.target_name || "—"}</span><span>{ACTION_JA[h.action] || h.action}{h.reason ? `（${h.reason}）` : ""}</span><span className="text-ink-mute">実行：{h.actor_name || "—"}</span></li>)}
      </ul>
    </details>
  );
}
