// HPBの予約通知メールの受け口（Google Apps Script から POST）。取り込みだけ（サロンボードには書き込まない）。
// ヘッダー X-Inbound-Secret：設定＞HPB連携で作った合言葉（店舗ごと）。本文 JSON：{ messageId, subject, body, date, from, dryRun? }
// SUPABASE_SERVICE_ROLE_KEY が無ければ何もしない（501）。
import { handleWebhook, inboundConfigured, HttpError, type WebhookBody } from "@/lib/inbound/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (!inboundConfigured()) return Response.json({ ok: false, reason: "not_configured", hint: "Vercel の環境変数 SUPABASE_SERVICE_ROLE_KEY を設定すると受け付けを始めます" }, { status: 501 });
  const len = Number(request.headers.get("content-length") || 0);
  if (len > 300_000) return Response.json({ ok: false, reason: "too_large" }, { status: 413 });
  let payload: WebhookBody;
  try { payload = (await request.json()) as WebhookBody; } catch { return Response.json({ ok: false, reason: "bad_json" }, { status: 400 }); }
  try { return Response.json(await handleWebhook(request.headers.get("x-inbound-secret"), payload)); }
  catch (e) {
    if (e instanceof HttpError) return Response.json({ ok: false, reason: e.message }, { status: e.status });
    console.error("inbound/hpb", String((e as Error)?.message || e).slice(0, 200));   // 本文の断片をログに残さない（200文字まで。監査 2026-11-15 L7）
    return Response.json({ ok: false, reason: "server_error" }, { status: 500 });
  }
}
export async function GET() {
  return Response.json({ ok: inboundConfigured(), service: "hpb-inbound", hint: inboundConfigured() ? "POST で受け付けます" : "SUPABASE_SERVICE_ROLE_KEY が未設定です" }, { status: inboundConfigured() ? 200 : 501 });
}
