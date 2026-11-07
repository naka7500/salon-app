// LINEの中の予約ページ：つながっているお客様の前回の入力（名前・電話・メール）を返す。本人確認は LIFF の IDトークン
import { handleMe, lineServerConfigured, HttpError } from "@/lib/line/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (!lineServerConfigured()) return Response.json({ ok: false, found: false }, { status: 501 });
  let body: { slug: string; idToken: string };
  try { body = (await request.json()) as { slug: string; idToken: string }; } catch { return Response.json({ ok: false, found: false }, { status: 400 }); }
  try { return Response.json(await handleMe(body), { headers: { "Cache-Control": "no-store" } }); }
  catch (e) {
    if (e instanceof HttpError) return Response.json({ ok: false, found: false }, { status: e.status });
    console.error("line/me", (e as Error)?.message?.slice(0, 200));
    return Response.json({ ok: false, found: false }, { status: 500 });
  }
}
