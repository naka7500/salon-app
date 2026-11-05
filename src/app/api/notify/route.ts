// 通知キューのメールを送る（Vercel Cron などから5分ごとに呼ぶ想定）。鍵が未設定なら何もしない。
import { flushQueue, notifyConfigured } from "@/lib/notify/send";

export async function POST(request: Request) {
  const secret = process.env.NOTIFY_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) return Response.json({ ok: false, reason: "unauthorized" }, { status: 401 });
  if (!notifyConfigured()) return Response.json({ ok: false, reason: "not_configured", hint: "SUPABASE_SERVICE_ROLE_KEY / RESEND_API_KEY / NOTIFY_FROM を設定すると送信を始めます" }, { status: 501 });
  try { return Response.json({ ok: true, ...(await flushQueue()) }); }
  catch (e) { return Response.json({ ok: false, reason: (e as Error).message }, { status: 500 }); }
}
export const GET = POST;
