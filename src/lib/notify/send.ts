// 通知キュー（notifications 表）のメール送信の「差し込み口」。
// 今はメール送信サービスの鍵が無いので、キューに積むところまで（public_create_booking / public_cancel_booking がDB内で積む）。
// Resend などをつなぐときは、Vercel の環境変数に下の5つを入れると /api/notify が送り始める（README・報告書に手順）。
//   SUPABASE_SERVICE_ROLE_KEY … キューを読む・送信済みにする（サーバだけで使う。ブラウザに出さない）
//   RESEND_API_KEY            … メール送信（https://resend.com）
//   NOTIFY_FROM               … 送信元（例 "KOKAGE <yoyaku@kokage.example>"。Resend で認証したドメイン）
//   NOTIFY_SECRET             … /api/notify を呼ぶための合言葉（Vercel Cron から Authorization: Bearer で渡す）
//   NOTIFY_SEND_ENABLED=true  … ★これが無いと送らない（鍵を入れただけで送り始めないように。監査 2026-11-08 C5）
//
// 踏み台にしない（監査 2026-11-08 C5）
//  - 画面（スタッフ）からは notifications に積めない（0021 で insert の権限を外した）。積むのはDBの関数・サーバだけ
//  - DB側（0021 のトリガー）で、宛先はその会社のお客様のメール・予約で入力されたメール・店舗の通知先だけ。HTMLは消す・長さは切る・会社ごと／宛先ごとに1時間の上限
//  - ここでも、送る種類はお客様あての予約確認・キャンセル確認と、お店あての新規・キャンセルだけ。本文は文字だけ・長さの上限
import { timingSafeEqual } from "node:crypto";

export interface QueuedMail { id: string; to_address: string | null; subject: string | null; body: string | null; kind?: string | null; channel?: string | null; created_at?: string | null }
export type Sender = (m: QueuedMail) => Promise<void>;

/** 送ってよい通知の種類 */
export const SENDABLE_KINDS = ["booking_confirmation", "cancel_confirmation", "new_booking", "cancel_booking"] as const;
export const MAX_SUBJECT = 200;
export const MAX_BODY = 4000;
/** これより古い送信待ちは送らない（あとから送信をオンにしたとき、たまっていた古い予約確認が一斉に出ないように。監査 2026-11-15 M8） */
export const MAX_AGE_MS = 24 * 3600_000;

export function notifyConfigured() {
  return !!(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY && process.env.RESEND_API_KEY && process.env.NOTIFY_FROM
    && process.env.NOTIFY_SEND_ENABLED === "true");
}

/** 文字だけにする（タグ・制御文字を消す）・長さを切る */
export function plainText(s: string | null | undefined, max: number) {
  return String(s ?? "").replace(/<[^>]*>/g, "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").slice(0, max);
}
const EMAIL_RE = /^[^@\s<>"',;]+@[^@\s<>"',;]+\.[^@\s<>"',;]+$/;

/** 送る前の最後の確認。だめなら理由（日本語）を返す */
export function sendBlockReason(m: QueuedMail, now: number = Date.now()): string | null {
  if (m.created_at && Number.isFinite(Date.parse(m.created_at)) && now - Date.parse(m.created_at) > MAX_AGE_MS) return "古い通知（24時間より前に積まれたもの）は送らない";
  if (!m.to_address) return "宛先なし（店舗の通知先メール未設定など）";
  if (!EMAIL_RE.test(m.to_address) || m.to_address.length > 254) return "宛先の形が正しくありません";
  if (m.channel && m.channel !== "email") return "メール以外の通知";
  if (!m.kind || !(SENDABLE_KINDS as readonly string[]).includes(m.kind)) return "送らない種類の通知";
  return null;
}

/** Resend で1通送る（文字だけ）。別のサービスに変えるときはこの関数を差し替える */
export const resendSender: Sender = async m => {
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: process.env.NOTIFY_FROM, to: [m.to_address], subject: plainText(m.subject, MAX_SUBJECT) || "(件名なし)", text: plainText(m.body, MAX_BODY) }),
  });
  if (!r.ok) throw new Error(`resend ${r.status}: ${(await r.text()).slice(0, 200)}`);
};

/** キューから最大 limit 通を送って、sent / failed / skipped にする */
export async function flushQueue(send: Sender = resendSender, limit = 50) {
  const base = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/notifications`;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const h = { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
  const q = await fetch(`${base}?status=eq.queued&channel=eq.email&order=created_at.asc&limit=${limit}&select=id,to_address,subject,body,kind,channel,created_at`, { headers: h });
  if (!q.ok) throw new Error(`queue ${q.status}`);
  const list = (await q.json()) as QueuedMail[];
  const result = { sent: 0, failed: 0, skipped: 0 };
  for (const m of list) {
    let patch: Record<string, unknown>;
    const block = sendBlockReason(m);
    if (block) { patch = { status: "skipped", error: block }; result.skipped++; }
    else {
      try { await send({ ...m, subject: plainText(m.subject, MAX_SUBJECT), body: plainText(m.body, MAX_BODY) }); patch = { status: "sent", sent_at: new Date().toISOString() }; result.sent++; }
      catch (e) { patch = { status: "failed", error: String((e as Error).message).slice(0, 500) }; result.failed++; }
    }
    await fetch(`${base}?id=eq.${encodeURIComponent(m.id)}&status=eq.queued`, { method: "PATCH", headers: h, body: JSON.stringify(patch) });
  }
  return result;
}

/** 合言葉の一定時間比較（長さが違えば false） */
export function safeEqual(a: string, b: string) {
  const x = Buffer.from(a, "utf8"), y = Buffer.from(b, "utf8");
  return x.length === y.length && timingSafeEqual(x, y);
}
