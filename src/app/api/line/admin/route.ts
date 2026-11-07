// 設定＞LINE連携 の操作（接続テスト・自分に試し送信）。ログイン中の人のトークン（Authorization: Bearer）で役割を確かめる。
import { handleAdmin, lineServerConfigured, HttpError, type LineAdminBody } from "@/lib/line/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (!lineServerConfigured()) return Response.json({ ok: false, message: "サーバの設定が未完了です（Vercel の環境変数 SUPABASE_SERVICE_ROLE_KEY を設定してください）" }, { status: 501 });
  const auth = request.headers.get("authorization") || "";
  const jwt = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  let body: LineAdminBody;
  try { body = (await request.json()) as LineAdminBody; } catch { return Response.json({ ok: false, message: "送った内容が読めませんでした" }, { status: 400 }); }
  try { return Response.json(await handleAdmin(jwt, body, new URL(request.url).origin)); }
  catch (e) {
    if (e instanceof HttpError) return Response.json({ ok: false, message: e.message }, { status: e.status });
    console.error("line/admin", (e as Error)?.message?.slice(0, 200));
    return Response.json({ ok: false, message: "うまくいきませんでした（時間をおいてもう一度）" }, { status: 500 });
  }
}
