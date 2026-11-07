// LINE の Webhook の受け口（店舗ごと：/api/line/webhook/<店舗ID>）。署名（X-Line-Signature）を確かめてから処理する。
// SUPABASE_SERVICE_ROLE_KEY が無ければ何もしない（501）。ログに本文・秘密は出さない。
import { handleWebhook, lineServerConfigured, HttpError } from "@/lib/line/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, ctx: { params: Promise<{ storeId: string }> }) {
  if (!lineServerConfigured()) return Response.json({ ok: false, reason: "not_configured" }, { status: 501 });
  const { storeId } = await ctx.params;
  const len = Number(request.headers.get("content-length") || 0);
  if (len > 1_000_000) return Response.json({ ok: false, reason: "too_large" }, { status: 413 });
  const raw = await request.text();
  if (raw.length > 1_000_000) return Response.json({ ok: false, reason: "too_large" }, { status: 413 });   // content-length が無い（chunked）ときも
  try { return Response.json(await handleWebhook(storeId, raw, request.headers.get("x-line-signature"), new URL(request.url).origin)); }
  catch (e) {
    if (e instanceof HttpError) return Response.json({ ok: false, reason: e.message }, { status: e.status });
    console.error("line/webhook", (e as Error)?.message?.slice(0, 200));
    return Response.json({ ok: false, reason: "server_error" }, { status: 500 });
  }
}
export async function GET() { return Response.json({ ok: lineServerConfigured(), service: "line-webhook", hint: "LINE からは POST で届きます" }, { status: lineServerConfigured() ? 200 : 501 }); }
