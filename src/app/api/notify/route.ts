// 通知キューのメールを送る（Vercel Cron などから5分ごとに呼ぶ想定）。鍵が未設定、または NOTIFY_SEND_ENABLED=true でなければ何もしない。
import { flushQueue, notifyConfigured, safeEqual } from "@/lib/notify/send";

export async function POST(request: Request) {
  const secret = process.env.NOTIFY_SECRET;
  if (!secret || !safeEqual(request.headers.get("authorization") || "", `Bearer ${secret}`)) return Response.json({ ok: false, reason: "unauthorized" }, { status: 401 });
  if (!notifyConfigured()) return Response.json({ ok: false, reason: "not_configured", hint: "SUPABASE_SERVICE_ROLE_KEY / RESEND_API_KEY / NOTIFY_FROM と NOTIFY_SEND_ENABLED=true を設定すると送信を始めます" }, { status: 501 });
  try { return Response.json({ ok: true, ...(await flushQueue()) }); }
  catch (e) { console.error("notify", String((e as Error)?.message || e).slice(0, 200)); return Response.json({ ok: false, reason: "server_error" }, { status: 500 }); }
}
export const GET = POST;
