// 通知キュー（notifications 表）のメール送信の「差し込み口」。
// 今はメール送信サービスの鍵が無いので、キューに積むところまで（public_create_booking / public_cancel_booking がDB内で積む）。
// Resend などをつなぐときは、Vercel の環境変数に下の4つを入れるだけで /api/notify が送り始める（README・報告書に手順）。
//   SUPABASE_SERVICE_ROLE_KEY … キューを読む・送信済みにする（サーバだけで使う。ブラウザに出さない）
//   RESEND_API_KEY            … メール送信（https://resend.com）
//   NOTIFY_FROM               … 送信元（例 "KOKAGE <yoyaku@kokage.example>"。Resend で認証したドメイン）
//   NOTIFY_SECRET             … /api/notify を呼ぶための合言葉（Vercel Cron から Authorization: Bearer で渡す）
export interface QueuedMail { id: string; to_address: string | null; subject: string | null; body: string | null }
export type Sender = (m: QueuedMail) => Promise<void>;

export function notifyConfigured() {
  return !!(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY && process.env.RESEND_API_KEY && process.env.NOTIFY_FROM);
}

/** Resend で1通送る。別のサービスに変えるときはこの関数を差し替える */
export const resendSender: Sender = async m => {
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: process.env.NOTIFY_FROM, to: [m.to_address], subject: m.subject || "(件名なし)", text: m.body || "" }),
  });
  if (!r.ok) throw new Error(`resend ${r.status}: ${(await r.text()).slice(0, 200)}`);
};

/** キューから最大 limit 通を送って、sent / failed / skipped（宛先なし）にする */
export async function flushQueue(send: Sender = resendSender, limit = 50) {
  const base = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/notifications`;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const h = { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
  const q = await fetch(`${base}?status=eq.queued&order=created_at.asc&limit=${limit}&select=id,to_address,subject,body`, { headers: h });
  if (!q.ok) throw new Error(`queue ${q.status}`);
  const list = (await q.json()) as QueuedMail[];
  const result = { sent: 0, failed: 0, skipped: 0 };
  for (const m of list) {
    let patch: Record<string, unknown>;
    if (!m.to_address) { patch = { status: "skipped", error: "宛先なし（店舗の通知先メール未設定など）" }; result.skipped++; }
    else {
      try { await send(m); patch = { status: "sent", sent_at: new Date().toISOString() }; result.sent++; }
      catch (e) { patch = { status: "failed", error: String((e as Error).message).slice(0, 500) }; result.failed++; }
    }
    await fetch(`${base}?id=eq.${m.id}`, { method: "PATCH", headers: h, body: JSON.stringify(patch) });
  }
  return result;
}
