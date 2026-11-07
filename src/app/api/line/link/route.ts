// お客様の LINE をお客様情報につなぐ（LIFF から。会計のQR／LINEの中でのネット予約）。
// 本人の確認は LIFF の IDトークンを LINE で確かめる。QRの合言葉は30分・1回だけ。
import { handleLink, lineServerConfigured, HttpError, type LinkBody } from "@/lib/line/server";
import { clientKey, limiter } from "@/lib/line/rateLimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (!lineServerConfigured()) return Response.json({ ok: false, message: "準備中です" }, { status: 501 });
  // 送り元ごとに 瞬間10回・1分に10回まで（QRの合言葉・予約のトークンの総当たりよけ。メモリの中＝インスタンスごとの目安）
  if (!limiter("line_link", 10, 10).take(clientKey(request))) return Response.json({ ok: false, message: "回数が多すぎます。少し待ってからもう一度お試しください" }, { status: 429, headers: { "Retry-After": "60" } });
  let body: LinkBody;
  try { body = (await request.json()) as LinkBody; } catch { return Response.json({ ok: false, message: "bad_json" }, { status: 400 }); }
  try { return Response.json(await handleLink(body)); }
  catch (e) {
    if (e instanceof HttpError) return Response.json({ ok: false, message: e.message }, { status: e.status });
    console.error("line/link", (e as Error)?.message?.slice(0, 200));
    return Response.json({ ok: false, message: "うまくいきませんでした（時間をおいてもう一度）" }, { status: 500 });
  }
}
