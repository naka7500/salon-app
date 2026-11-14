// LINEの中の予約（LIFF）の確定（0022・案B）。本人の確認は LIFF の IDトークンを LINE で確かめる。
// 予約・お客様・LINE のつながりは、サーバ（service_role）が service_create_booking を呼んで1トランザクションで作る。
// ブラウザのネット予約（LINE以外）は、今までどおり anon の public_create_booking（ここは通らない）。
import { handleBook, lineServerConfigured, HttpError } from "@/lib/line/server";
import { clientKey, limiter } from "@/lib/line/rateLimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (!lineServerConfigured()) return Response.json({ ok: false, message: "準備中です" }, { status: 501 });
  // 送り元ごとに 瞬間6回・1分に6回まで（1人が予約の確定を押す回数としては十分。DB側に LINE ごと1日5件・電話番号ごとの上限もある）
  if (!limiter("line_book", 6, 6).take(clientKey(request))) return Response.json({ ok: false, message: "too_many" }, { status: 429, headers: { "Retry-After": "60" } });
  let body: unknown;
  try { body = await request.json(); } catch { return Response.json({ ok: false, message: "bad_request" }, { status: 400 }); }
  try { return Response.json(await handleBook(body, new URL(request.url).origin), { headers: { "Cache-Control": "no-store" } }); }
  catch (e) {
    if (e instanceof HttpError) return Response.json({ ok: false, message: e.message }, { status: e.status });
    console.error("line/book", (e as Error)?.message?.slice(0, 200));
    return Response.json({ ok: false, message: "うまくいきませんでした（時間をおいてもう一度）" }, { status: 500 });
  }
}
