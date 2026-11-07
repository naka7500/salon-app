// 初回ログイン：仮パスワードから自分のパスワードに変える（本人だけ）。新しいパスワードはログに出さない。
import { HttpError, changeOwnPassword, supabaseLoginDeps } from "@/lib/staffLoginServer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store, max-age=0" };

export async function POST(request: Request) {
  const deps = supabaseLoginDeps();
  if (!deps.configured) return Response.json({ ok: false, message: "サーバの設定が未完了です（SUPABASE_SERVICE_ROLE_KEY）" }, { status: 501, headers: NO_STORE });
  const auth = request.headers.get("authorization") || "";
  const jwt = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  let body: { password?: string };
  try { body = await request.json(); } catch { return Response.json({ ok: false, message: "送った内容が読めませんでした" }, { status: 400, headers: NO_STORE }); }
  try { return Response.json(await changeOwnPassword(deps, jwt, String(body?.password ?? "")), { headers: NO_STORE }); }
  catch (e) {
    if (e instanceof HttpError) return Response.json({ ok: false, message: e.message }, { status: e.status, headers: NO_STORE });
    console.error("staff/password", (e as Error)?.message?.slice(0, 160));
    return Response.json({ ok: false, message: "うまくいきませんでした（時間をおいてもう一度）" }, { status: 500, headers: NO_STORE });
  }
}
