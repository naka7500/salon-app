// 設定＞HPB連携 の操作（再処理・手で直す・無視・テストメール）。ログイン中の人のトークン（Authorization: Bearer）で役割を確かめる。
import { handleAdmin, inboundConfigured, HttpError, type AdminBody } from "@/lib/inbound/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (!inboundConfigured()) return Response.json({ ok: false, message: "サーバの設定が未完了です（Vercel の環境変数 SUPABASE_SERVICE_ROLE_KEY を設定してください）" }, { status: 501 });
  const auth = request.headers.get("authorization") || "";
  const jwt = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  let body: AdminBody;
  try { body = (await request.json()) as AdminBody; } catch { return Response.json({ ok: false, message: "送った内容が読めませんでした" }, { status: 400 }); }
  try { return Response.json(await handleAdmin(jwt, body)); }
  catch (e) {
    if (e instanceof HttpError) return Response.json({ ok: false, message: e.message }, { status: e.status });
    console.error("inbound/hpb/admin", e);
    return Response.json({ ok: false, message: `うまくいきませんでした：${String((e as Error)?.message || e).slice(0, 200)}` }, { status: 500 });
  }
}
