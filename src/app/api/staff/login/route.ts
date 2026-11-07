// 設定＞スタッフ「ログインの発行」：状態の一覧・発行・招待・パスワード再設定・停止・再開。
// ログイン中の人のトークン（Authorization: Bearer）で、対象の会社での役割をサーバで確かめる。
// 仮パスワードは返事にだけ入れる（保存・ログ出力しない）。返事はキャッシュさせない。
import { HttpError, loginAction, loginStatus, supabaseLoginDeps } from "@/lib/staffLoginServer";
import type { StaffLoginAction } from "@/lib/staffLogin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store, max-age=0" };
const json = (b: unknown, status = 200) => Response.json(b, { status, headers: NO_STORE });

export async function POST(request: Request) {
  const deps = supabaseLoginDeps();
  if (!deps.configured) return json({ ok: false, message: "サーバの設定が未完了です（Vercel の環境変数 SUPABASE_SERVICE_ROLE_KEY を設定してください）" }, 501);
  const auth = request.headers.get("authorization") || "";
  const jwt = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  let body: (StaffLoginAction | { kind: "status" }) & { store_id?: string };
  try { body = await request.json(); } catch { return json({ ok: false, message: "送った内容が読めませんでした" }, 400); }
  try {
    if (body?.kind === "status") return json(await loginStatus(deps, jwt, body.store_id || ""));
    if (!body || !["issue", "invite", "reset", "stop", "resume"].includes(body.kind)) return json({ ok: false, message: "unknown" }, 400);
    return json(await loginAction(deps, jwt, body as StaffLoginAction & { store_id?: string }, new URL(request.url).origin));
  } catch (e) {
    if (e instanceof HttpError) return json({ ok: false, message: e.message, code: e.code }, e.status);
    console.error("staff/login", body?.kind, (e as Error)?.message?.slice(0, 160));
    return json({ ok: false, message: "うまくいきませんでした（時間をおいてもう一度）" }, 500);
  }
}
