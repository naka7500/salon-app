// LINE連携のサーバ側（Next.js のルートからだけ使う。ブラウザには出さない）。
// サービスキー（SUPABASE_SERVICE_ROLE_KEY）で Supabase を読み書きし、LINE の API を呼ぶ。キーが無ければ何もしない（501）。
// 秘密（チャネルシークレット・アクセストークン）はここでだけ読む。ログ（console）に秘密・本文を出さない。
import { createHash, randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Booking, Customer, HistVisit, ID, Menu, Sale, Shift, Store } from "@/lib/db/types";
import { ensureJst } from "@/lib/inbound/tz";
import { verifyLineSignature } from "./signature";
import { handleEvents, jst, addDaysStr, runCron, sampleMessages, type LineEvent, type LineIO, type LineSender } from "./engine";
import { vacancyRateOf } from "./vacancy";
import { previewText } from "./templates";
import type { LineLink, LineMessage, LineOutMessage, LineQueueItem, LineSettings } from "./types";
import { defaultLineSettings, lineCredentialsSet, linkSendable } from "./types";
import { JWT_RE, LINK_AUDIT_TABLE, REQUEST_TTL_DAYS, bookErrorForClient, decideRequestError, isOwnerCheck, lineBookInputError, prefillAllowed, type LineBookBody, type LineLinkRequest, type LinkAuditAction } from "./linkPolicy";
import { applyLink, type LinkApplyIO, type NoticeResult } from "./linkApply";
import { MANUAL_KIND, canSendManual, directSendError, manualSendError, parseDirectBody, parseManualItems, type DirectSendResult, type ManualItem, type ManualResult, type ManualSendResult } from "./manual";

export function lineServerConfigured() { return !!(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY); }
export class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }
let admin: SupabaseClient | null = null;
function db() {
  if (!admin) admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
  return admin;
}
function must<T>(r: { data: T | null; error: { message: string } | null }): T { if (r.error) throw new Error(r.error.message); return r.data as T; }
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sha256hex = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

/** アプリのURL（予約ページのリンク用）。APP_BASE_URL → Vercel の本番URL */
export function appBaseUrl(fallbackOrigin?: string | null) {
  const v = process.env.APP_BASE_URL || (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : "") || fallbackOrigin || "";
  return v.replace(/\/+$/, "");
}

// ---------------------------------------------------------------------------
// LINE の API（呼ぶのはサーバだけ）
// ---------------------------------------------------------------------------
const LINE_API = "https://api.line.me";
async function lineFetch(token: string, path: string, init: RequestInit & { retryKey?: string } = {}) {
  const headers: Record<string, string> = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  if (init.retryKey) headers["X-Line-Retry-Key"] = init.retryKey;
  const r = await fetch(`${LINE_API}${path}`, { ...init, headers: { ...headers, ...(init.headers as Record<string, string> || {}) }, signal: AbortSignal.timeout(10_000) });
  return r;
}
export function liveSender(token: string): LineSender {
  return {
    async push(to, messages, retryKey) {
      const r = await lineFetch(token, "/v2/bot/message/push", { method: "POST", body: JSON.stringify({ to, messages }), retryKey });
      if (r.status === 409) return;   // 同じ再送キーはもう受け付け済み（二重に送られない）
      if (!r.ok) throw new Error(`LINE push ${r.status}: ${(await r.text()).slice(0, 200)}`);
    },
    async reply(replyToken, messages) {
      const r = await lineFetch(token, "/v2/bot/message/reply", { method: "POST", body: JSON.stringify({ replyToken, messages }) });
      if (!r.ok) throw new Error(`LINE reply ${r.status}: ${(await r.text()).slice(0, 200)}`);
    },
  };
}
/** LIFF の IDトークンを LINE で確かめる（LINEログインのチャネルID）。sub＝ユーザーID */
export async function verifyIdToken(idToken: string, loginChannelId: string) {
  const r = await fetch(`${LINE_API}/oauth2/v2.1/verify`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ id_token: idToken, client_id: loginChannelId }), signal: AbortSignal.timeout(10_000) });
  if (!r.ok) throw new HttpError(401, "LINEの確認に失敗しました（もう一度開き直してください）");
  const j = (await r.json()) as { sub?: string; name?: string };
  if (!j.sub || !/^U[0-9a-f]{32}$/.test(j.sub)) throw new HttpError(401, "LINEの確認に失敗しました");
  return { userId: j.sub, name: j.name ? String(j.name).slice(0, 80) : null };
}

// ---------------------------------------------------------------------------
// 店舗ごとの材料
// ---------------------------------------------------------------------------
interface Ctx { store: Store; settings: LineSettings; secret: string | null; token: string | null; menus: Menu[] }
/** 0019（line_links.linked_via・bookings.customer_created）が流れているか。無ければ連携しない・前回入力を返さない（安全側に止める） */
async function ready19() { const r = await db().from("line_links").select("linked_via").limit(1); if (r.error) throw new HttpError(503, "DB更新 0019 がまだ流れていません（0019_line_link_guard.sql を流してください）"); }
/** 0020（line_link_requests）が流れているか。無ければ LINE予約からの連携・承認はしない（安全側） */
async function ready20() { const r = await db().from("line_link_requests").select("id").limit(1); if (r.error) throw new HttpError(503, "DB更新 0020 がまだ流れていません（0020_line_link_requests.sql を流してください）"); }
/** 0022（案B：service_create_booking・companies.legal_name）が流れているか。無ければ LINE予約は止める（安全側。ブラウザの予約は止まらない） */
async function ready22() { const r = await db().from("companies").select("legal_name").limit(1); if (r.error) throw new HttpError(503, "DB更新 0022 がまだ流れていません（0022_line_identity.sql を流してください）"); }
async function ready() { const r = await db().from("line_channels").select("store_id").limit(1); if (r.error) throw new HttpError(503, "DB更新 0015 がまだ流れていません（0015_line.sql を流してください）"); }
export async function storeCtx(storeId: string): Promise<Ctx> {
  ensureJst();
  const sb = db();
  const store = must(await sb.from("stores").select("*").eq("id", storeId).maybeSingle()) as Store | null;
  if (!store) throw new HttpError(404, "店舗が見つかりません");
  const st = must(await sb.from("line_channels").select("*").eq("store_id", storeId).maybeSingle()) as LineSettings | null;
  const sec = must(await sb.from("line_channel_secrets").select("channel_secret, access_token").eq("store_id", storeId).maybeSingle()) as { channel_secret: string | null; access_token: string | null } | null;
  const menus = must(await sb.from("menus").select("*").eq("store_id", storeId)) as Menu[];
  const settings = { ...defaultLineSettings(storeId), ...(st || {}), confirm_time: (st?.confirm_time || "18:00").slice(0, 5), revisit_time: (st?.revisit_time || "11:00").slice(0, 5) } as LineSettings;
  return { store, settings, secret: sec?.channel_secret ?? null, token: sec?.access_token ?? null, menus };
}
const linkUrl = (c: Ctx, base: string) => (c.settings.liff_id ? `https://liff.line.me/${c.settings.liff_id}` : c.store.slug && base ? `${base}/r/${c.store.slug}` : null);

export function serverIO(c: Ctx, base: string): LineIO {
  const sb = db(); const S = c.store.id;
  const dayRange = (d: string) => { const s = new Date(`${d}T00:00:00+09:00`); return [s.toISOString(), new Date(s.getTime() + 86400000).toISOString()]; };
  return {
    store: { id: S, name: c.store.name, phone: c.store.phone, slug: c.store.slug, business_type: c.store.business_type }, settings: c.settings, menus: c.menus,
    now: () => new Date(),
    bookingUrl: () => linkUrl(c, base),
    async linkByUser(uid) { return must(await sb.from("line_links").select("*").eq("store_id", S).eq("line_user_id", uid).maybeSingle()) as LineLink | null; },
    async linkOfCustomer(cid) { return must(await sb.from("line_links").select("*").eq("store_id", S).eq("customer_id", cid).maybeSingle()) as LineLink | null; },
    async saveLink(p, opts) {
      // 同じお客様についている別の LINE を外すのは、会計のQR（token モード）だけ（0019。LINE予約からの自動連携では付け替えない）
      if (p.customer_id && opts?.takeOver) must(await sb.from("line_links").update({ customer_id: null }).eq("store_id", S).eq("customer_id", p.customer_id).neq("line_user_id", p.line_user_id));
      return must(await sb.from("line_links").upsert({ ...p, store_id: S, updated_at: new Date().toISOString() }, { onConflict: "store_id,line_user_id" }).select().single()) as LineLink;
    },
    async booking(id) { return UUID_RE.test(id) ? (must(await sb.from("bookings").select("*").eq("id", id).maybeSingle()) as Booking | null) : null; },
    async setBookingConfirm(b, a) {
      const patch = { line_confirm: a, line_confirm_at: new Date().toISOString() };
      if (b.pair_group) must(await sb.from("bookings").update(patch).eq("store_id", S).eq("pair_group", b.pair_group));
      else must(await sb.from("bookings").update(patch).eq("id", b.id));
    },
    async customerName(cid) { return ((must(await sb.from("customers").select("name").eq("id", cid).maybeSingle()) as { name: string } | null)?.name) ?? null; },
    async bookingsOn(date) { const [s, e] = dayRange(date); return must(await sb.from("bookings").select("*").eq("store_id", S).gte("start_at", s).lt("start_at", e)) as Booking[]; },
    async lastVisits(ids) {
      const best = new Map<ID, { date: string; menu_ids: ID[] }>();
      const put = (cid: ID | null | undefined, date: string, menu_ids: ID[]) => { if (!cid) return; const cur = best.get(cid); if (!cur || date > cur.date) best.set(cid, { date, menu_ids }); };
      for (let i = 0; i < ids.length; i += 100) {
        const part = ids.slice(i, i + 100);
        const sales = must(await sb.from("sales").select("customer_id, sold_at, sale_lines(menu_id)").eq("store_id", S).eq("status", "confirmed").in("customer_id", part).order("sold_at", { ascending: false }).limit(1000)) as (Pick<Sale, "customer_id" | "sold_at"> & { sale_lines: { menu_id: string | null }[] })[];
        sales.forEach(x => put(x.customer_id, jst(new Date(x.sold_at)).date, (x.sale_lines || []).map(l => l.menu_id).filter(Boolean) as ID[]));
        const done = must(await sb.from("bookings").select("customer_id, start_at, menu_ids").eq("store_id", S).eq("status", "done").in("customer_id", part).order("start_at", { ascending: false }).limit(1000)) as Pick<Booking, "customer_id" | "start_at" | "menu_ids">[];
        done.forEach(x => put(x.customer_id, jst(new Date(x.start_at)).date, x.menu_ids || []));
        const hist = (await sb.from("historical_visits").select("customer_id, visited_on, last_visit_on").eq("store_id", S).in("customer_id", part).limit(2000)).data as Pick<HistVisit, "customer_id" | "visited_on" | "last_visit_on">[] | null;
        (hist || []).forEach(h => { const d = h.visited_on || h.last_visit_on; if (d) put(h.customer_id, d, []); });
      }
      return [...best.entries()].map(([customer_id, v]) => ({ customer_id, ...v }));
    },
    async futureBookingCustomers(ids) {
      const out = new Set<ID>();
      for (let i = 0; i < ids.length; i += 100) (must(await sb.from("bookings").select("customer_id").eq("store_id", S).in("status", ["booked", "arrived"]).gt("start_at", new Date().toISOString()).in("customer_id", ids.slice(i, i + 100))) as { customer_id: ID }[]).forEach(x => out.add(x.customer_id));
      return out;
    },
    async sendableLinks() { return (must(await sb.from("line_links").select("*").eq("store_id", S).eq("followed", true).eq("opted_out", false).not("customer_id", "is", null).limit(5000)) as LineLink[]).filter(linkSendable); },   // 0020：持ち主の確認待ちは送らない
    async vacancyRate(from, days) {
      const to = addDaysStr(from, days);
      const shifts = (must(await sb.from("shifts").select("*").eq("store_id", S).gte("date", from).lt("date", to).not("staff_id", "is", null)) as Shift[]).map(x => ({ ...x, start_time: x.start_time?.slice(0, 5), end_time: x.end_time?.slice(0, 5), break_start: x.break_start?.slice(0, 5) ?? null, break_end: x.break_end?.slice(0, 5) ?? null }));
      const [s] = dayRange(from), [e] = dayRange(to);
      const bookings = must(await sb.from("bookings").select("*").eq("store_id", S).gte("start_at", s).lt("start_at", e)) as Booking[];
      return vacancyRateOf(from, days, shifts, bookings, c.menus);
    },
    async hasEvent(eid) { return !!(must(await sb.from("line_messages").select("id").eq("store_id", S).eq("event_id", eid).limit(1)) as unknown[]).length; },
    async logMessage(m) { const r = await sb.from("line_messages").insert({ ...m, text: m.text?.slice(0, 4000) ?? null }); if (r.error && !/duplicate key/.test(r.error.message)) throw new Error(r.error.message); },
    async notifyStaff(n) { must(await sb.from("notifications").insert({ store_id: S, booking_id: n.booking_id ?? null, kind: n.kind, channel: "app", to_address: null, subject: n.subject.slice(0, 300), body: n.body.slice(0, 4000), status: "skipped", error: "アプリ内のお知らせ（メールは送らない）" })); },
    async lastOutAt(uid, kind) { const r = must(await sb.from("line_messages").select("created_at").eq("store_id", S).eq("line_user_id", uid).eq("direction", "out").eq("kind", kind).neq("status", "failed").order("created_at", { ascending: false }).limit(1)) as { created_at: string }[]; return r[0]?.created_at ?? null; },
    async enqueue(items) {
      if (!items.length) return 0;
      const r = must(await sb.from("line_send_queue").upsert(items, { onConflict: "dedupe_key", ignoreDuplicates: true }).select("id")) as { id: string }[];
      return r.length;
    },
    async queued(limit) { return must(await sb.from("line_send_queue").select("*").eq("store_id", S).eq("status", "queued").lte("scheduled_at", new Date().toISOString()).order("created_at").limit(limit)) as LineQueueItem[]; },
    async claim(id) { const r = must(await sb.from("line_send_queue").update({ status: "sending" }).eq("id", id).eq("status", "queued").select("id")) as unknown[]; return r.length === 1; },
    async finish(id, p) { must(await sb.from("line_send_queue").update(p).eq("id", id)); },
    async monthCount() {
      const t = jst(new Date()); const start = new Date(`${t.date.slice(0, 7)}-01T00:00:00+09:00`).toISOString();
      const r = await sb.from("line_messages").select("id", { count: "exact", head: true }).eq("store_id", S).eq("direction", "out").eq("counted", true).gte("created_at", start);
      if (r.error) throw new Error(r.error.message); return r.count ?? 0;
    },
  };
}

// ---------------------------------------------------------------------------
// Webhook（LINE から）。署名を確かめてから処理する。返事は必ず早く（LINE は1秒程度で待つのをやめる）
// ---------------------------------------------------------------------------
export async function handleWebhook(storeId: string, rawBody: string, signature: string | null, origin?: string | null) {
  if (!UUID_RE.test(storeId)) throw new HttpError(404, "not_found");
  await ready();
  const c = await storeCtx(storeId);
  if (!c.secret) throw new HttpError(401, "channel_secret_not_set");
  if (!verifyLineSignature(rawBody, c.secret, signature)) throw new HttpError(401, "bad_signature");
  let body: { events?: LineEvent[] };
  try { body = JSON.parse(rawBody); } catch { throw new HttpError(400, "bad_json"); }
  const events = Array.isArray(body.events) ? body.events : [];
  if (!events.length) return { ok: true, events: 0 };                 // LINE の「検証」ボタン
  const sender: LineSender = c.token ? liveSender(c.token) : { async push() { throw new Error("token_not_set"); }, async reply() { throw new Error("token_not_set"); } };
  const out = await handleEvents(serverIO(c, appBaseUrl(origin)), sender, events);
  return { ok: true, events: out.length };
}

// ---------------------------------------------------------------------------
// Cron（Vercel Cron などから）：オンの店舗ごとに 前日確認 → 再来案内 → 送信
// ---------------------------------------------------------------------------
export async function handleCron(origin?: string | null) {
  await ready();
  const list = must(await db().from("line_channels").select("store_id").eq("enabled", true)) as { store_id: string }[];
  const results: Record<string, unknown> = {};
  // 0020：LINE連携の確認待ちは30日で期限切れ（表が無ければ何もしない）
  try { await db().from("line_link_requests").update({ status: "expired", decided_at: new Date().toISOString() }).eq("status", "pending").lt("created_at", new Date(Date.now() - REQUEST_TTL_DAYS * 86400_000).toISOString()); } catch {}
  for (const { store_id } of list) {
    try {
      const c = await storeCtx(store_id);
      if (!c.token || !lineCredentialsSet(c.settings)) { results[store_id] = { skipped: "秘密が未設定" }; continue; }
      results[store_id] = await runCron(serverIO(c, appBaseUrl(origin)), liveSender(c.token));
    } catch (e) { results[store_id] = { error: String((e as Error).message).slice(0, 200) }; }
  }
  return { ok: true, stores: list.length, results };
}

// ---------------------------------------------------------------------------
// 画面から（接続テスト・自分に試し送信）。ログイン中の人の役割をサーバで確かめる
// ---------------------------------------------------------------------------
export type LineAdminBody = { store_id: string } & ({ kind: "test_connection" } | { kind: "test_send"; template: "confirm" | "revisit" | "ok_reply" | "change_reply" | "ack" } | { kind: "push_customer"; items: ManualItem[] } | { kind: "push_customer_direct"; customer_id: string; text: string });
export async function handleAdmin(jwt: string | null, body: LineAdminBody, origin?: string | null) {
  if (!jwt) throw new HttpError(401, "ログインしてください");
  if (!body?.store_id || !UUID_RE.test(body.store_id)) throw new HttpError(400, "店舗が分かりません");
  const sb = db();
  const u = await sb.auth.getUser(jwt);
  if (u.error || !u.data.user) throw new HttpError(401, "ログインの期限が切れています。もう一度ログインしてください");
  const bannedUntil = (u.data.user as { banned_until?: string | null }).banned_until;
  if (bannedUntil && Date.parse(bannedUntil) > Date.now()) throw new HttpError(403, "このログインは止められています");
  const store = must(await sb.from("stores").select("company_id").eq("id", body.store_id).maybeSingle()) as { company_id: string } | null;
  if (!store) throw new HttpError(404, "店舗が見つかりません");
  const me = (must(await sb.from("staff").select("id, name, role, active").eq("auth_user_id", u.data.user.id).eq("company_id", store.company_id)) as { id: string; name: string; role: string; active: boolean | null }[]).filter(x => x.active !== false);
  const role = me.some(x => x.role === "owner") ? "owner" : me.some(x => x.role === "manager") ? "manager" : me.some(x => x.role === "staff") ? "staff" : null;
  if (body.kind === "push_customer") {
    if (!canSendManual(role)) throw new HttpError(403, "LINEで連絡できるのは、オーナー・店長・スタッフだけです");
    return pushCustomers(body.store_id, body);
  }
  if (body.kind === "push_customer_direct") {
    if (!canSendManual(role)) throw new HttpError(403, "LINEで連絡できるのは、オーナー・店長・スタッフだけです");
    return pushCustomerDirect(body.store_id, store.company_id, body);
  }
  if (role !== "owner" && role !== "manager") throw new HttpError(403, "この操作はオーナー・店長だけができます");
  await ready();
  const c = await storeCtx(body.store_id);
  if (!c.token) throw new HttpError(400, "チャネルアクセストークンが保存されていません");
  if (body.kind === "test_connection") {
    const info = await lineFetch(c.token, "/v2/bot/info");
    if (!info.ok) {
      const msg = info.status === 401 ? "つながりませんでした：アクセストークンが違うか、期限切れです" : `つながりませんでした（LINE ${info.status}）`;
      await sb.from("line_channels").update({ last_test_at: new Date().toISOString(), last_test_result: msg }).eq("store_id", c.store.id);
      return { ok: false, message: msg };
    }
    const j = (await info.json()) as { displayName?: string; basicId?: string };
    let quota: number | null = null, usage: number | null = null;
    try { const q = await lineFetch(c.token, "/v2/bot/message/quota"); if (q.ok) { const qq = (await q.json()) as { type?: string; value?: number }; quota = qq.type === "limited" ? qq.value ?? null : null; } } catch {}
    try { const q = await lineFetch(c.token, "/v2/bot/message/quota/consumption"); if (q.ok) usage = ((await q.json()) as { totalUsage?: number }).totalUsage ?? null; } catch {}
    const msg = `つながりました：${j.displayName || ""}（${j.basicId || ""}）${c.secret ? "" : "／チャネルシークレットが未保存です"}`;
    await sb.from("line_channels").update({ bot_name: j.displayName ?? null, bot_basic_id: j.basicId ?? null, quota_value: quota, quota_usage: usage, quota_checked_at: new Date().toISOString(), last_test_at: new Date().toISOString(), last_test_result: msg }).eq("store_id", c.store.id);
    return { ok: true, message: msg, bot_name: j.displayName, basic_id: j.basicId, quota, usage };
  }
  if (body.kind === "test_send") {
    if (role !== "owner") throw new HttpError(403, "試し送信はオーナーだけができます");
    if (!c.settings.test_line_user_id) throw new HttpError(400, "送り先（自分のLINE）が決まっていません。LINE受信箱で自分のメッセージの「これは自分」を押してください");
    const io = serverIO(c, appBaseUrl(origin));
    const msgs: LineOutMessage[] = sampleMessages(io, body.template, io.bookingUrl());
    await liveSender(c.token).push(c.settings.test_line_user_id, msgs, randomUUID());
    await io.logMessage({ store_id: c.store.id, line_user_id: c.settings.test_line_user_id, direction: "out", kind: "test", text: previewText(msgs), status: "sent", counted: true } as Omit<LineMessage, "id" | "created_at">);
    return { ok: true, message: "自分のLINEに送りました" };
  }
  throw new HttpError(400, "unknown");
}

// ---------------------------------------------------------------------------
// スタッフが手で送る（予約詳細の「LINEで連絡」・台帳の「この日のお客様に連絡」）
//  ・人が内容を確かめて送るものなので「LINE連携を使う」がオフでも送る（秘密が保存済みのときだけ）
//  ・1人ずつ確かめる：同じ店舗の予約・キャンセルでない・つながっている・配信停止でない・1時間の回数・今月の通数
//  ・本文は line_messages に残す（受信箱で見返せる）。console には本文・お客様の情報を出さない
// ---------------------------------------------------------------------------
async function pushCustomers(storeId: string, body: unknown): Promise<ManualSendResult> {
  const parsed = parseManualItems(body);
  if ("error" in parsed) throw new HttpError(400, parsed.error);
  await ready();
  const c = await storeCtx(storeId);
  if (!c.token || !lineCredentialsSet(c.settings)) throw new HttpError(400, "LINEの秘密（チャネルシークレット・アクセストークン）が保存されていません（設定＞LINE連携）");
  const sb = db(); const io = serverIO(c, "");
  const sender = liveSender(c.token);
  const limit = c.settings.plan_limit;
  let used = await io.monthCount();
  const hourAgo = new Date(Date.now() - 3600_000).toISOString();
  const countOut = async (bookingId: string | null) => {
    let q = sb.from("line_messages").select("id", { count: "exact", head: true }).eq("store_id", storeId).eq("direction", "out").eq("kind", MANUAL_KIND).eq("status", "sent").gte("created_at", hourAgo);
    if (bookingId) q = q.eq("booking_id", bookingId);
    const r = await q; if (r.error) throw new Error(r.error.message); return r.count ?? 0;
  };
  let storeRecent = await countOut(null);
  const results: ManualResult[] = [];
  for (const it of parsed.items) {
    const b = must(await sb.from("bookings").select("id, store_id, status, customer_id").eq("id", it.booking_id).maybeSingle()) as { id: string; store_id: string; status: string; customer_id: string | null } | null;
    const link = b?.customer_id ? await io.linkOfCustomer(b.customer_id) : null;
    const err = manualSendError({ booking: b, storeId, link, recentForBooking: b ? await countOut(b.id) : 0, recentForStore: storeRecent, used, limit });
    if (err) { results.push({ booking_id: it.booking_id, ok: false, message: err }); continue; }
    const base = { store_id: storeId, line_user_id: link!.line_user_id, customer_id: b!.customer_id, booking_id: b!.id, direction: "out" as const, kind: MANUAL_KIND, text: it.text };
    try {
      await sender.push(link!.line_user_id, [{ type: "text", text: it.text }], randomUUID());
      await io.logMessage({ ...base, status: "sent", counted: true } as Omit<LineMessage, "id" | "created_at">);
      used++; storeRecent++;
      results.push({ booking_id: it.booking_id, ok: true, message: "送りました" });
    } catch (e) {
      const m = String((e as Error)?.message || "");
      const code = /LINE push (\d{3})/.exec(m)?.[1];
      const why = code === "429" ? "LINEの送信の上限に達しています（今月の通数・回数）" : code === "400" ? "LINEに受け付けられませんでした（ブロックされている可能性があります）" : code ? `LINEに送れませんでした（${code}）` : "LINEに送れませんでした（時間をおいてもう一度）";
      await io.logMessage({ ...base, status: "failed", counted: false, error: m.slice(0, 300) } as Omit<LineMessage, "id" | "created_at">).catch(() => {});
      results.push({ booking_id: it.booking_id, ok: false, message: why });
    }
  }
  const okN = results.filter(r => r.ok).length;
  return { ok: okN > 0, message: results.length === 1 ? results[0].message : `${results.length}人中 ${okN}人に送りました`, results, used, limit };
}

// 顧客詳細から（予約に結びつけない1人あて）。確かめ方は pushCustomers と同じ＋同じお客様へ1時間3通まで
async function pushCustomerDirect(storeId: string, companyId: string, body: unknown): Promise<DirectSendResult> {
  const parsed = parseDirectBody(body);
  if ("error" in parsed) throw new HttpError(400, parsed.error);
  await ready();
  const c = await storeCtx(storeId);
  if (!c.token || !lineCredentialsSet(c.settings)) throw new HttpError(400, "LINEの秘密（チャネルシークレット・アクセストークン）が保存されていません（設定＞LINE連携）");
  const sb = db(); const io = serverIO(c, "");
  const limit = c.settings.plan_limit;
  const used = await io.monthCount();
  const hourAgo = new Date(Date.now() - 3600_000).toISOString();
  const countOut = async (customerId: string | null) => {
    let q = sb.from("line_messages").select("id", { count: "exact", head: true }).eq("store_id", storeId).eq("direction", "out").eq("kind", MANUAL_KIND).eq("status", "sent").gte("created_at", hourAgo);
    if (customerId) q = q.eq("customer_id", customerId);
    const r = await q; if (r.error) throw new Error(r.error.message); return r.count ?? 0;
  };
  const cust = must(await sb.from("customers").select("id, company_id, merged_into").eq("id", parsed.customer_id).maybeSingle()) as { id: string; company_id: string; merged_into: string | null } | null;
  const link = cust ? await io.linkOfCustomer(cust.id) : null;
  const err = directSendError({ customer: cust, companyId, link, recentForCustomer: cust ? await countOut(cust.id) : 0, recentForStore: await countOut(null), used, limit });
  if (err) return { ok: false, message: err, used, limit };
  const base = { store_id: storeId, line_user_id: link!.line_user_id, customer_id: cust!.id, booking_id: null, direction: "out" as const, kind: MANUAL_KIND, text: parsed.text };
  try {
    await liveSender(c.token).push(link!.line_user_id, [{ type: "text", text: parsed.text }], randomUUID());
    await io.logMessage({ ...base, status: "sent", counted: true } as Omit<LineMessage, "id" | "created_at">);
    return { ok: true, message: "送りました", used: used + 1, limit };
  } catch (e) {
    const m = String((e as Error)?.message || "");
    const code = /LINE push (\d{3})/.exec(m)?.[1];
    const why = code === "429" ? "LINEの送信の上限に達しています（今月の通数・回数）" : code === "400" ? "LINEに受け付けられませんでした（ブロックされている可能性があります）" : code ? `LINEに送れませんでした（${code}）` : "LINEに送れませんでした（時間をおいてもう一度）";
    await io.logMessage({ ...base, status: "failed", counted: false, error: m.slice(0, 300) } as Omit<LineMessage, "id" | "created_at">).catch(() => {});
    return { ok: false, message: why, used, limit };
  }
}

// ---------------------------------------------------------------------------
// お客様の LINE をつなぐ（LIFF から。ログイン不要＝IDトークンで本人を確かめる）
// ---------------------------------------------------------------------------
export type LinkBody = { slug: string; idToken: string; mode: "token"; token: string };
// LINEの中の予約ページ：つながっているお客様なら、前回の名前・電話・メールを返す（本人のIDトークンを LINE で確かめてから・その店舗の分だけ）
//  0022（案B）：返すのは、LINE予約で本人としてつないだ（line_id）・会計のQR（token）・LINE予約で新しく作られた（booking_new・0019〜0020）・確認待ちをスタッフが承認した（staff_approved）つながりだけ。
//  既存のお客様に LINE予約でつないだだけ（booking）や 0019 より前のつながり（linked_via なし）は返さない（電話番号だけで他人の情報を引けないように）
export async function handleMe(body: { slug: string; idToken: string }) {
  if (!body?.slug || typeof body.idToken !== "string" || body.idToken.length > 4000 || !JWT_RE.test(body.idToken)) throw new HttpError(400, "bad_request");
  const store = must(await db().from("stores").select("id").eq("slug", String(body.slug).toLowerCase().trim()).eq("web_booking_enabled", true).maybeSingle()) as { id: string } | null;
  if (!store) throw new HttpError(404, "not_found");
  const set = must(await db().from("line_channels").select("login_channel_id").eq("store_id", store.id).maybeSingle()) as { login_channel_id: string | null } | null;
  if (!set?.login_channel_id) throw new HttpError(403, "not_ready");
  await ready19();
  const who = await verifyIdToken(body.idToken, set.login_channel_id);
  const l = must(await db().from("line_links").select("*").eq("store_id", store.id).eq("line_user_id", who.userId).not("customer_id", "is", null).maybeSingle()) as LineLink | null;   // * ＝0020 の needs_confirm も（無い DB でも動く）
  if (!prefillAllowed(l)) return { ok: true, found: false };
  const c = must(await db().from("customers").select("name, kana, phone, email").eq("id", l!.customer_id!).maybeSingle()) as { name: string; kana: string | null; phone: string | null; email: string | null } | null;
  if (!c) return { ok: true, found: false };
  return { ok: true, found: true, name: c.name || "", kana: c.kana || "", phone: c.phone || "", email: c.email || "" };
}

/** つなぐ・付け替えるときの IO（serverIO＋監査ログ）。actor はスタッフの承認のときだけ */
function linkApplyIO(c: Ctx, companyId: string, actor: { auth: string | null; staff_id: string | null; name: string } | null): LinkApplyIO {
  const io = serverIO(c, "");
  return {
    linkOfCustomer: io.linkOfCustomer, linkByUser: io.linkByUser, saveLink: io.saveLink, logMessage: io.logMessage, monthCount: io.monthCount,
    audit: (action, after) => auditLink(c.store.id, companyId, action, String(after.customer_id ?? ""), after, actor),
  };
}
/** 監査ログ（table_name='line_link'）。ID だけ（名前・電話・メール・LINEの表示名・LINEのユーザーIDは書かない） */
async function auditLink(storeId: string, companyId: string, action: LinkAuditAction, rowId: string, after: Record<string, unknown>, actor: { auth: string | null; staff_id: string | null; name: string } | null) {
  const r = await db().from("audit_logs").insert({ actor: actor?.auth ?? null, actor_staff_id: actor?.staff_id ?? null, actor_name: actor?.name ?? "お客様（LINE）", store_id: storeId, table_name: LINK_AUDIT_TABLE, row_id: rowId || null, action, before: null, after: { ...after, company_id: companyId } });
  if (r.error) console.error("line-link audit", r.error.message.slice(0, 120));
}

export async function handleLink(body: LinkBody) {
  if (!body?.slug || typeof body.idToken !== "string" || body.idToken.length > 4000 || !JWT_RE.test(body.idToken)) throw new HttpError(400, "bad_request");
  await ready(); await ready19(); await ready20();
  const store = must(await db().from("stores").select("id, company_id").eq("slug", String(body.slug).toLowerCase().trim()).maybeSingle()) as { id: string; company_id: string } | null;
  if (!store) throw new HttpError(404, "店舗が見つかりません");
  const c = await storeCtx(store.id);
  // つなぐだけ（何も送らない）なので、「LINE連携を使う」がオフの間もつなぐ。オフのあいだに予約した人も、オンにした日から届く
  if (!c.settings.login_channel_id || !lineCredentialsSet(c.settings)) throw new HttpError(403, "この店舗のLINE連携は準備中です");
  const who = await verifyIdToken(body.idToken, c.settings.login_channel_id);
  const sb = db();
  const io = linkApplyIO(c, store.company_id, null);
  const sender = c.token ? liveSender(c.token) : null;
  const base = { storeId: store.id, storeName: c.store.name, planLimit: c.settings.plan_limit, lineUserId: who.userId, displayName: who.name };
  if (body.mode !== "token" || !/^[0-9a-f]{64}$/.test(body.token || "")) throw new HttpError(400, "QRコードが正しくありません");
  // 1回だけ：使われていない・期限内のものを「使用済み」にできたときだけ
  const r = must(await sb.from("line_link_tokens").update({ used_at: new Date().toISOString(), used_line_user_id: who.userId })
    .eq("token_hash", sha256hex(body.token)).eq("store_id", store.id).is("used_at", null).gt("expires_at", new Date().toISOString()).select("customer_id")) as { customer_id: string }[];
  if (r.length !== 1) throw new HttpError(410, "このQRコードは使えません（30分の期限切れ・使用済み）。お店で新しいQRコードを出してもらってください");
  const out = await applyLink(io, sender, { ...base, customerId: r[0].customer_id, via: "token", takeOver: true, logText: "LINE連携（会計のQR）" });
  const cust = must(await sb.from("customers").select("name").eq("id", r[0].customer_id).maybeSingle()) as Pick<Customer, "name"> | null;
  return { ok: true, name: prefillAllowed({ customer_id: r[0].customer_id, linked_at: out.link.linked_at, linked_via: out.linkedVia }) ? cust?.name ?? null : null, basic_id: c.settings.bot_basic_id ?? null };
}

// ---------------------------------------------------------------------------
// LINEの中の予約（0022・案B）：LINEのユーザーIDが本人。電話番号では既存のお客様につながない
//  ・IDトークンを LINE で確かめる → service_role で service_create_booking（そのLINEにつながったお客様がいればその人の予約、
//    いなければ新しいお客様を作ってすぐつなぐ）。予約・お客様・つながりは DB の1トランザクション
//  ・料金・空き・クーポンの条件・上限（電話番号ごと・店全体の新規・同じLINEは1日5件）は DB の関数が確かめる（ブラウザの予約と同じ本体）
//  ・返すのはブラウザの予約と同じ内容（お客様IDは返さない）＋ line: つないだ・新しいお客様か
// ---------------------------------------------------------------------------
export interface LineBookResult { ok: true; booking: Record<string, unknown>; line: { linked: true; customer_created: boolean } }
export async function handleBook(body: unknown): Promise<LineBookResult> {
  const bad = lineBookInputError(body);
  if (bad) throw new HttpError(400, bad);
  const b = body as LineBookBody;
  await ready(); await ready19(); await ready22();
  const store = must(await db().from("stores").select("id, company_id").eq("slug", String(b.slug).toLowerCase().trim()).eq("web_booking_enabled", true).maybeSingle()) as { id: string; company_id: string } | null;
  if (!store) throw new HttpError(404, "store_not_found");
  const c = await storeCtx(store.id);
  if (!c.settings.login_channel_id || !lineCredentialsSet(c.settings)) throw new HttpError(403, "この店舗のLINE連携は準備中です");
  const who = await verifyIdToken(b.idToken, c.settings.login_channel_id);
  const r = await db().rpc("service_create_booking", {
    p_slug: b.slug, p_menu: b.menu_id, p_start: b.start_at, p_name: b.name, p_kana: b.kana, p_phone: b.phone, p_email: b.email,
    p_intake: b.intake ?? [], p_coupon: b.coupon_id || null, p_code: b.code || null, p_staff: b.staff_id || null, p_lang: b.lang || "ja",
    p_options: b.option_ids?.length ? b.option_ids : null, p_line_user_id: who.userId, p_line_display_name: who.name,
  });
  if (r.error) {
    if (r.error.code === "PGRST202" || /Could not find the function|does not exist/.test(r.error.message)) throw new HttpError(503, "DB更新 0022 がまだ流れていません（0022_line_identity.sql を流してください）");
    const code = bookErrorForClient(r.error.message);
    if (code === "forbidden") { console.error("line/book forbidden (service role?)"); throw new HttpError(500, "うまくいきませんでした（時間をおいてもう一度）"); }
    if (code !== r.error.message) { console.error("line/book", r.error.message.slice(0, 200)); throw new HttpError(500, code); }
    throw new HttpError(["slot_taken", "duplicate", "too_many", "coupon_sold_out"].includes(code) ? 409 : 400, code);
  }
  const { customer_id: customerId, customer_created, line_linked, ...rest } = (r.data ?? {}) as Record<string, unknown> & { customer_id?: string; customer_created?: boolean; line_linked?: boolean };
  // 新しいお客様を作ってつないだときだけ監査ログ（ID だけ。予約そのものは booking_history に残る）
  if (customer_created) await auditLink(store.id, store.company_id, "link_create", String(customerId ?? ""), { store_id: store.id, customer_id: customerId ?? null, via: "line_id", booking_no: (rest.booking_no as string) ?? null, line_linked: !!line_linked }, null);
  return { ok: true, booking: rest, line: { linked: true, customer_created: !!customer_created } };
}

// ---------------------------------------------------------------------------
// LINE連携の確認待ち（0020）：スタッフが予約詳細・顧客詳細で「この方のLINEとつなぐ／つながない」
//  ・ログイン中の人を確かめ、確認待ちの店舗の会社で在籍の owner・manager・staff のときだけ（viewer・退職者・止めた人はだめ）
//  ・つなぐと、そのお客様に別の LINE がついていれば外れる（前の LINE に「送り先が変わりました」を送る）
// ---------------------------------------------------------------------------
export type LinkRequestBody = { request_id: string; decision: "approve" | "reject" };
export async function handleLinkRequest(jwt: string | null, body: LinkRequestBody): Promise<{ ok: boolean; message: string; notice?: NoticeResult; repointed?: boolean }> {
  if (!jwt) throw new HttpError(401, "ログインしてください");
  if (!body || !UUID_RE.test(String(body.request_id || "")) || (body.decision !== "approve" && body.decision !== "reject")) throw new HttpError(400, "送った内容が正しくありません");
  const sb = db();
  const u = await sb.auth.getUser(jwt);
  if (u.error || !u.data.user) throw new HttpError(401, "ログインの期限が切れています。もう一度ログインしてください");
  const bannedUntil = (u.data.user as { banned_until?: string | null }).banned_until;
  if (bannedUntil && Date.parse(bannedUntil) > Date.now()) throw new HttpError(403, "このログインは止められています");
  await ready(); await ready19(); await ready20();
  const req = must(await sb.from("line_link_requests").select("*").eq("id", body.request_id).maybeSingle()) as LineLinkRequest | null;
  if (!req) throw new HttpError(404, "確認待ちが見つかりません");
  const store = must(await sb.from("stores").select("company_id").eq("id", req.store_id).maybeSingle()) as { company_id: string } | null;
  if (!store) throw new HttpError(404, "店舗が見つかりません");
  const me = (must(await sb.from("staff").select("id, name, role, active").eq("auth_user_id", u.data.user.id).eq("company_id", store.company_id)) as { id: string; name: string; role: string; active: boolean | null }[]).filter(x => x.active !== false);
  const role = me.some(x => x.role === "owner") ? "owner" : me.some(x => x.role === "manager") ? "manager" : me.some(x => x.role === "staff") ? "staff" : null;
  const actorRow = me.find(x => x.role === role) ?? null;
  const err = decideRequestError({ role, request: req });
  if (err) {
    if (err.status === 410) await sb.from("line_link_requests").update({ status: "expired", decided_at: new Date().toISOString() }).eq("id", req.id).eq("status", "pending");
    throw new HttpError(err.status, err.message);
  }
  const actor = { auth: u.data.user.id, staff_id: actorRow?.id ?? null, name: actorRow?.name ?? "" };
  const decidedAt = new Date().toISOString();
  // 先に「決まった」にする（同時に2人が押しても1回だけ）
  const claimed = must(await sb.from("line_link_requests").update({ status: body.decision === "approve" ? "approved" : "rejected", decided_by: actor.staff_id, decided_at: decidedAt }).eq("id", req.id).eq("status", "pending").select("id")) as { id: string }[];
  if (claimed.length !== 1) throw new HttpError(409, "この確認待ちは、もう決まっています（画面を開き直してください）");
  const ids = { request_id: req.id, booking_id: req.booking_id ?? null };
  if (body.decision === "reject") {
    // 持ち主の確認（C7）を「外す」：今つながっている LINE（＝確認待ちの LINE）をこのお客様から外す
    const cur = must(await sb.from("line_links").select("*").eq("store_id", req.store_id).eq("customer_id", req.customer_id).maybeSingle()) as LineLink | null;
    const ownerCheck = isOwnerCheck(req, cur);
    if (ownerCheck) {
      must(await sb.from("line_links").update({ customer_id: null, needs_confirm: false, updated_at: new Date().toISOString() }).eq("id", cur!.id));
      await auditLink(req.store_id, store.company_id, "link_remove", req.customer_id, { store_id: req.store_id, customer_id: req.customer_id, link_id: cur!.id, ...ids }, actor);
    }
    await auditLink(req.store_id, store.company_id, "request_reject", req.customer_id, { store_id: req.store_id, customer_id: req.customer_id, ...ids }, actor);
    return { ok: true, message: ownerCheck ? "このLINEをお客様から外しました（このLINEにはもう届きません）" : "つながないことにしました" };
  }
  const cust = must(await sb.from("customers").select("id, company_id, merged_into").eq("id", req.customer_id).maybeSingle()) as { id: string; company_id: string; merged_into: string | null } | null;
  if (!cust || cust.company_id !== store.company_id || cust.merged_into) {
    await sb.from("line_link_requests").update({ status: "pending", decided_by: null, decided_at: null }).eq("id", req.id);
    throw new HttpError(409, "お客様情報が見つからないか、統合されています。お店で会計のときにQRコードでつないでください");
  }
  const c = await storeCtx(req.store_id);
  let out: Awaited<ReturnType<typeof applyLink>>;
  try {
    out = await applyLink(linkApplyIO(c, store.company_id, actor), c.token ? liveSender(c.token) : null, {
      storeId: req.store_id, storeName: c.store.name, planLimit: c.settings.plan_limit, lineUserId: req.line_user_id, displayName: req.display_name ?? null,
      customerId: req.customer_id, via: "staff_approved", takeOver: true, logText: "LINE連携（確認待ちをスタッフが承認）", ids,
    });
  } catch (e) {
    await sb.from("line_link_requests").update({ status: "pending", decided_by: null, decided_at: null }).eq("id", req.id);   // つなげなかったら確認待ちに戻す
    throw e;
  }
  await auditLink(req.store_id, store.company_id, "request_approve", req.customer_id, { store_id: req.store_id, customer_id: req.customer_id, link_id: out.link.id ?? null, ...ids }, actor);
  const noticeMsg = out.repointed ? (out.notice === "sent" ? "（前につながっていたLINEに、送り先が変わったお知らせを送りました）" : out.notice === "skipped_quota" ? "（今月の通数の上限のため、前のLINEへのお知らせは送っていません）" : out.notice === "failed" ? "（前のLINEへのお知らせは送れませんでした）" : "") : "";
  return { ok: true, message: `このお客様のLINEとつなぎました${noticeMsg}`, notice: out.notice, repointed: out.repointed };
}
