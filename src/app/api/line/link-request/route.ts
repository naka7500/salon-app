// LINE連携の確認待ち（0020）を、スタッフが「この方のLINEとつなぐ／つながない」で決める。
// ログイン中の人のトークン（Authorization: Bearer）で、在籍の owner・manager・staff かをサーバで確かめ直す。
import { handleLinkRequest, lineServerConfigured, HttpError, type LinkRequestBody } from "@/lib/line/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (!lineServerConfigured()) return Response.json({ ok: false, message: "サーバの設定が未完了です（Vercel の環境変数 SUPABASE_SERVICE_ROLE_KEY を設定してください）" }, { status: 501 });
  const auth = request.headers.get("authorization") || "";
  const jwt = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  let body: LinkRequestBody;
  try { body = (await request.json()) as LinkRequestBody; } catch { return Response.json({ ok: false, message: "送った内容が読めませんでした" }, { status: 400 }); }
  try { return Response.json(await handleLinkRequest(jwt, body)); }
  catch (e) {
    if (e instanceof HttpError) return Response.json({ ok: false, message: e.message }, { status: e.status });
    console.error("line/link-request", (e as Error)?.message?.slice(0, 200));
    return Response.json({ ok: false, message: "うまくいきませんでした（時間をおいてもう一度）" }, { status: 500 });
  }
}
