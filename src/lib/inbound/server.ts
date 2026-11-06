// HPB取り込みのサーバ側（Next.js のルートからだけ使う。ブラウザには出さない）。
// サービスキー（SUPABASE_SERVICE_ROLE_KEY）で Supabase に書く。キーが無ければ何もしない（501）。
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Booking, Lane, Menu, Shift, Staff, Store } from "@/lib/db/types";
import { isTestStore } from "@/lib/db/types";
import { ensureJst } from "./tz";
import { ingestHpbMail, processStoredMail, type HpbMapping, type HpbSettings, type InboundIO, type InboundMail } from "./process";
import { makeTestMail, type TestMailOptions } from "./testMail";
import { mergeHpbConfig, parseHpbMail, type HpbManualFix } from "./hpb";

export function inboundConfigured() { return !!(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY); }
let admin: SupabaseClient | null = null;
function db() {
  if (!admin) admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
  return admin;
}
function must<T>(r: { data: T | null; error: { message: string } | null }): T { if (r.error) throw new Error(r.error.message); return r.data as T; }
const hm5 = (t: string | null | undefined) => (t ? t.slice(0, 5) : t ?? null);
export const sha256hex = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
/** 合言葉の照合（ハッシュどうしを一定時間で比べる） */
export function secretMatches(secret: string, hash: string | null | undefined) {
  if (!hash || !/^[0-9a-f]{64}$/.test(hash)) return false;
  const a = Buffer.from(sha256hex(secret), "hex"), b = Buffer.from(hash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }

/** 0011 が入っているか */
async function ready() { const r = await db().from("hpb_settings").select("store_id").limit(1); if (r.error) throw new HttpError(503, "DB更新 0011 がまだ流れていません（Supabase の SQL エディタで 0011_hpb_inbound.sql を流してください）"); }

/** その店の処理の口（サービスキー） */
export async function storeIO(storeId: string): Promise<InboundIO> {
  ensureJst();
  const sb = db();
  const store = must(await sb.from("stores").select("*").eq("id", storeId).maybeSingle()) as Store | null;
  if (!store) throw new HttpError(404, "店舗が見つかりません");
  const links = must(await sb.from("staff_stores").select("staff_id").eq("store_id", storeId)) as { staff_id: string }[];
  const staff = links.length ? (must(await sb.from("staff").select("*").in("id", links.map(x => x.staff_id))) as Staff[]).filter(s => s.active !== false && s.show_on_ledger !== false).sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || a.name.localeCompare(b.name, "ja")) : [];
  const lanes = must(await sb.from("lanes").select("*").eq("store_id", storeId).eq("active", true).order("sort_order")) as Lane[];
  const menus = (must(await sb.from("menus").select("*").eq("store_id", storeId).eq("active", true).order("sort_order")) as Menu[]).map(m => ({ ...m, time_from: hm5(m.time_from), time_to: hm5(m.time_to) }));
  const settings = must(await sb.from("hpb_settings").select("*").eq("store_id", storeId).maybeSingle()) as HpbSettings | null;
  const mappings = must(await sb.from("hpb_mappings").select("*").eq("store_id", storeId).order("sort_order")) as HpbMapping[];
  const dayRange = (d: string) => { const s = new Date(`${d}T00:00:00+09:00`); return [s.toISOString(), new Date(s.getTime() + 86400000).toISOString()]; };
  return {
    store, staff, lanes, menus, settings: settings ?? { store_id: storeId, enabled: false }, mappings,
    async shiftsOn(date) { return (must(await sb.from("shifts").select("*").eq("store_id", storeId).eq("date", date).not("staff_id", "is", null)) as Shift[]).map(r => ({ ...r, start_time: hm5(r.start_time), end_time: hm5(r.end_time), break_start: hm5(r.break_start), break_end: hm5(r.break_end) })); },
    async bookingsOn(date) { const [s, e] = dayRange(date); return must(await sb.from("bookings").select("*").eq("store_id", storeId).gte("start_at", s).lt("start_at", e)) as Booking[]; },
    async bookingsByRef(ref) { return must(await sb.from("bookings").select("*").eq("store_id", storeId).eq("channel", "hpb").eq("external_ref", ref)) as Booking[]; },
    async findCustomer(phone, kana, name) { return must(await sb.rpc("inbound_find_customer", { p_company: store.company_id, p_phone: phone, p_kana: kana, p_name: name })) as string | null; },
    async createCustomer(c) { return (must(await sb.from("customers").insert({ company_id: store.company_id, name: c.name, kana: c.kana, phone: c.phone, source: "hpb" }).select("id").single()) as { id: string }).id; },
    async insertBookings(rows) { return must(await sb.from("bookings").insert(rows).select()) as Booking[]; },
    async updateBooking(id, patch) { must(await sb.from("bookings").update(patch).eq("id", id).eq("store_id", storeId)); },
    async notify(n) { must(await sb.from("notifications").insert({ store_id: storeId, booking_id: n.booking_id, kind: n.kind, channel: "app", to_address: null, subject: n.subject.slice(0, 300), body: n.body.slice(0, 4000), status: "skipped", error: "アプリ内のお知らせ（メールは送らない）" })); },
    newId: () => randomUUID(),
    async findMail(mid) { return must(await sb.from("inbound_mails").select("*").eq("message_id", mid).maybeSingle()) as InboundMail | null; },
    async getMail(id) { return must(await sb.from("inbound_mails").select("*").eq("id", id).eq("store_id", storeId).maybeSingle()) as InboundMail | null; },
    async insertMail(m) { return must(await sb.from("inbound_mails").insert(m).select().single()) as InboundMail; },
    async updateMail(id, patch) { must(await sb.from("inbound_mails").update(patch).eq("id", id)); },
  };
}

// ---------------------------------------------------------------------------
// Webhook（Apps Script から）
// ---------------------------------------------------------------------------
export interface WebhookBody { messageId?: string; subject?: string; body?: string; date?: string; from?: string; dryRun?: boolean }
/** 合言葉は「店舗ID.ランダム」。店舗IDで設定を引いて、ハッシュを一定時間で照合する */
export async function handleWebhook(secretHeader: string | null, payload: WebhookBody) {
  const secret = (secretHeader || "").trim();
  const storeId = secret.split(".")[0];
  if (!secret || !UUID_RE.test(storeId) || secret.length < 50 || secret.length > 200) throw new HttpError(401, "unauthorized");
  await ready();
  const st = must(await db().from("hpb_settings").select("store_id, secret_hash").eq("store_id", storeId).maybeSingle()) as { store_id: string; secret_hash: string | null } | null;
  if (!secretMatches(secret, st?.secret_hash ?? null)) throw new HttpError(401, "unauthorized");
  const subject = String(payload.subject ?? "").slice(0, 1000), body = String(payload.body ?? "").slice(0, 100000);
  const messageId = String(payload.messageId ?? "").trim().slice(0, 300);
  if (!messageId) throw new HttpError(400, "messageId がありません");
  if (!subject && !body) throw new HttpError(400, "件名も本文も空です");
  const io = await storeIO(storeId);
  if (payload.dryRun) {
    // 試し（保存も台帳への反映もしない）：読み取り結果だけ返す
    const parsed = parseHpbMail({ subject, body, date: payload.date }, mergeHpbConfig(io.settings?.parser_config));
    return { ok: true, dryRun: true, parsed };
  }
  const r = await ingestHpbMail(io, { messageId, subject, body, date: payload.date ?? null, from: payload.from ?? null });
  return { ok: true, duplicate: r.duplicate, mail_id: r.mail.id, status: r.mail.status, action: r.mail.action };
}

// ---------------------------------------------------------------------------
// 画面から（再処理・手で直す・無視・テストメール）。ログイン中の人の役割をサーバで確かめる
// ---------------------------------------------------------------------------
export type AdminBody = { store_id: string } & ({ kind: "reprocess"; mail_id: string } | { kind: "fix"; mail_id: string; manual: HpbManualFix } | { kind: "ignore"; mail_id: string } | { kind: "test"; test: TestMailOptions });
export async function handleAdmin(jwt: string | null, body: AdminBody) {
  if (!jwt) throw new HttpError(401, "ログインしてください");
  if (!body?.store_id || !UUID_RE.test(body.store_id)) throw new HttpError(400, "店舗が分かりません");
  const sb = db();
  const u = await sb.auth.getUser(jwt);
  if (u.error || !u.data.user) throw new HttpError(401, "ログインの期限が切れています。もう一度ログインしてください");
  const store = must(await sb.from("stores").select("*, companies(name)").eq("id", body.store_id).maybeSingle()) as (Store & { companies?: { name: string } | null }) | null;
  if (!store) throw new HttpError(404, "店舗が見つかりません");
  const me = (must(await sb.from("staff").select("role, active").eq("auth_user_id", u.data.user.id).eq("company_id", store.company_id)) as { role: string; active: boolean | null }[]).filter(x => x.active !== false);
  const role = me.some(x => x.role === "owner") ? "owner" : me.some(x => x.role === "manager") ? "manager" : null;
  if (!role) throw new HttpError(403, "この操作はオーナー・店長だけができます");
  await ready();
  const io = await storeIO(store.id);
  if (body.kind === "test") {
    if (role !== "owner") throw new HttpError(403, "テストメールはオーナーだけが送れます");
    if (!isTestStore({ name: store.name, company_name: store.companies?.name ?? null })) throw new HttpError(403, "テストメールはテスト店舗（練習用）だけで使えます");
    const m = makeTestMail(body.test);
    const r = await ingestHpbMail(io, { messageId: `test-${randomUUID()}`, subject: m.subject, body: m.body, date: new Date().toISOString(), from: "test@salon-app", isTest: true });
    return { ok: true, status: r.mail.status, action: r.mail.action, mail_id: r.mail.id, booking_ids: r.mail.booking_ids ?? [], reservation_no: m.reservationNo };
  }
  const mail = await io.getMail(body.mail_id);
  if (!mail) throw new HttpError(404, "メールが見つかりません");
  if (body.kind === "ignore") {
    await io.updateMail(mail.id, { status: "ignored", action: `${mail.action ? mail.action + "\n" : ""}手で「無視」にしました`, processed_at: new Date().toISOString() });
    return { ok: true, status: "ignored", mail_id: mail.id };
  }
  const r = await processStoredMail(io, mail, body.kind === "fix" ? body.manual : undefined);
  return { ok: true, status: r.mail.status, action: r.mail.action, mail_id: mail.id, booking_ids: r.mail.booking_ids ?? [] };
}
