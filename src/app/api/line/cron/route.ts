// LINE の自動送信（前日確認・再来案内）。Vercel Cron（vercel.json）から呼ぶ。
// 合言葉：環境変数 CRON_SECRET（Vercel Cron は Authorization: Bearer <CRON_SECRET> を自動で付ける）。
// SUPABASE_SERVICE_ROLE_KEY・CRON_SECRET が無ければ何もしない（501）。店舗の「LINE連携を使う」がオフなら送らない。
import { timingSafeEqual } from "node:crypto";
import { handleCron, lineServerConfigured, HttpError } from "@/lib/line/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || !lineServerConfigured()) return Response.json({ ok: false, reason: "not_configured", hint: "SUPABASE_SERVICE_ROLE_KEY と CRON_SECRET を設定すると動きます" }, { status: 501 });
  if (!safeEqual(request.headers.get("authorization") || "", `Bearer ${secret}`)) return Response.json({ ok: false, reason: "unauthorized" }, { status: 401 });
  try { return Response.json(await handleCron(new URL(request.url).origin)); }
  catch (e) {
    if (e instanceof HttpError) return Response.json({ ok: false, reason: e.message }, { status: e.status });
    console.error("line/cron", (e as Error)?.message?.slice(0, 200));
    return Response.json({ ok: false, reason: "server_error" }, { status: 500 });
  }
}
export const POST = GET;
/** 一定時間比較（長さが違えば false） */
function safeEqual(a: string, b: string) {
  const x = Buffer.from(a, "utf8"), y = Buffer.from(b, "utf8");
  return x.length === y.length && timingSafeEqual(x, y);
}
