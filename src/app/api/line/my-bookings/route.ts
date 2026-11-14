// LINEの中の予約ページ：自分の今後の予約（確認・キャンセルの入口）。本人確認は LIFF の IDトークン（監査 2026-11-15 S4）
import { handleMyBookings, lineServerConfigured, HttpError } from "@/lib/line/server";
import { clientKey, limiter } from "@/lib/line/rateLimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (!lineServerConfigured()) return Response.json({ ok: false, bookings: [] }, { status: 501 });
  // 送り元ごとに 瞬間20回・1分に20回まで（ログイン不要のAPIなので安全柵。/api/line/me と同じ）
  if (!limiter("line_my_bookings", 20, 20).take(clientKey(request))) return Response.json({ ok: false, bookings: [] }, { status: 429, headers: { "Retry-After": "60" } });
  let body: { slug: string; idToken: string };
  try { body = (await request.json()) as { slug: string; idToken: string }; } catch { return Response.json({ ok: false, bookings: [] }, { status: 400 }); }
  try { return Response.json(await handleMyBookings(body), { headers: { "Cache-Control": "no-store" } }); }
  catch (e) {
    if (e instanceof HttpError) return Response.json({ ok: false, bookings: [] }, { status: e.status });
    console.error("line/my-bookings", (e as Error)?.message?.slice(0, 200));
    return Response.json({ ok: false, bookings: [] }, { status: 500 });
  }
}
