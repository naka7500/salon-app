// お客様の LINE をお客様情報につなぐ（LIFF から。会計のQR／LINEの中でのネット予約）。
// 本人の確認は LIFF の IDトークンを LINE で確かめる。QRの合言葉は30分・1回だけ。
import { handleLink, lineServerConfigured, HttpError, type LinkBody } from "@/lib/line/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (!lineServerConfigured()) return Response.json({ ok: false, message: "準備中です" }, { status: 501 });
  let body: LinkBody;
  try { body = (await request.json()) as LinkBody; } catch { return Response.json({ ok: false, message: "bad_json" }, { status: 400 }); }
  try { return Response.json(await handleLink(body)); }
  catch (e) {
    if (e instanceof HttpError) return Response.json({ ok: false, message: e.message }, { status: e.status });
    console.error("line/link", (e as Error)?.message?.slice(0, 200));
    return Response.json({ ok: false, message: "うまくいきませんでした（時間をおいてもう一度）" }, { status: 500 });
  }
}
