// LINE連携の中身（Webhook の処理・前日確認と再来案内の送信待ちづくり・送信）。
// DB と LINE の呼び出しは IO / Sender に分けてある（本番＝サーバのサービスキー、デモ＝ブラウザの中）。単体テストあり。
//
// 安全のための決まり（ここで必ず守る）
//  ・店舗の「LINE連携を使う」がオフなら、何も送らない（受信の記録だけ）
//  ・前日確認・再来案内・自動のお礼は、それぞれオンのときだけ
//  ・友だちでない人・お知らせを止めた人には送らない（送る直前にもう一度確かめる）
//  ・同じ予約の前日確認・同じ回の再来案内は1回だけ（dedupe_key）。送信は LINE の再送キー（X-Line-Retry-Key）付き
//  ・月の通数が上限に達したら、再来案内（急がないもの）は止める。80%で画面に注意
import type { Booking, ID, Menu } from "@/lib/db/types";
import type { ConfirmAnswer, LineLink, LineMessage, LineOutMessage, LineQueueItem, LineSettings } from "./types";
import { linkSendable } from "./types";
import { confirmMessage, optKeyword, OPT_RESUME_REPLY, OPT_STOP_REPLY, parsePostback, previewText, renderTemplate, templateOf, textMessage } from "./templates";

export interface LineStoreInfo { id: ID; name: string; phone?: string | null; slug?: string | null; business_type?: string }
export interface LastVisit { customer_id: ID; date: string; menu_ids: ID[] }
export interface LineIO {
  store: LineStoreInfo; settings: LineSettings; menus: Menu[];
  now(): Date;
  /** 予約ページのURL（https://…/r/slug）。無ければ null */
  bookingUrl(): string | null;
  linkByUser(lineUserId: string): Promise<LineLink | null>;
  linkOfCustomer(customerId: ID): Promise<LineLink | null>;
  /** (店舗, line_user_id) で作る or 直す */
  saveLink(l: Partial<LineLink> & { line_user_id: string }): Promise<LineLink>;
  booking(id: ID): Promise<Booking | null>;
  /** 前日確認の返事を予約に記録（ペアの相手にも） */
  setBookingConfirm(b: Booking, a: ConfirmAnswer): Promise<void>;
  customerName(customerId: ID): Promise<string | null>;
  /** その日（日本時間 'YYYY-MM-DD'）の予約 */
  bookingsOn(date: string): Promise<Booking[]>;
  /** LINE とつながっているお客様の、最後の来店（会計・会計済みの予約・前のPOSの来店） */
  lastVisits(customerIds: ID[]): Promise<LastVisit[]>;
  /** この先の予約があるお客様 */
  futureBookingCustomers(customerIds: ID[]): Promise<Set<ID>>;
  /** 送れる相手（友だち・停止していない・お客様とつながっている）全員 */
  sendableLinks(): Promise<LineLink[]>;
  /** 空き率（0〜1）。from から days 日。分からないときは null */
  vacancyRate(from: string, days: number): Promise<number | null>;
  hasEvent(eventId: string): Promise<boolean>;
  logMessage(m: Omit<LineMessage, "id" | "created_at">): Promise<void>;
  notifyStaff(n: { booking_id?: ID | null; kind: "line_change" | "line_message"; subject: string; body: string }): Promise<void>;
  lastOutAt(lineUserId: string, kind: string): Promise<string | null>;
  /** 送信待ちに入れる（dedupe_key が同じものは入れない）。入れた数 */
  enqueue(items: Omit<LineQueueItem, "id" | "created_at" | "status" | "attempts">[]): Promise<number>;
  queued(limit: number): Promise<LineQueueItem[]>;
  /** queued → sending（ほかの処理が先に取っていたら false） */
  claim(id: ID): Promise<boolean>;
  finish(id: ID, patch: Partial<Pick<LineQueueItem, "status" | "error" | "attempts" | "sent_at">>): Promise<void>;
  /** 今月の、通数に数える送信の数 */
  monthCount(): Promise<number>;
}
export interface LineSender {
  push(to: string, messages: LineOutMessage[], retryKey: string): Promise<void>;
  reply(replyToken: string, messages: LineOutMessage[]): Promise<void>;
  /** デモ（送らずにプレビューだけ） */ demo?: boolean;
}

// ---------------------------------------------------------------------------
// 日本時間
// ---------------------------------------------------------------------------
const pad = (n: number) => String(n).padStart(2, "0");
export function jst(now: Date) {
  const t = new Date(now.getTime() + 9 * 3600_000);
  return { date: `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`, hm: `${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}`, dow: t.getUTCDay() };
}
export function addDaysStr(d: string, n: number) { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); }
export const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400_000);
const WD = ["日", "月", "火", "水", "木", "金", "土"];
export function jaDate(iso: string) { const j = jst(new Date(iso)); const [, m, d] = j.date.split("-").map(Number); return { date: `${m}月${d}日（${WD[j.dow]}）`, time: j.hm }; }
const hm5 = (t: string | null | undefined, def: string) => (t && /^\d{1,2}:\d{2}/.test(t) ? t.slice(0, 5).padStart(5, "0") : def);
/** 送ってよい時間帯（夜は送らない） */
export const CONFIRM_UNTIL = "21:00", REVISIT_UNTIL = "20:00";

// ---------------------------------------------------------------------------
// 再来案内の日数（メニューの設定 → 名前 → 業態）
// ---------------------------------------------------------------------------
export const REVISIT_DEFAULTS = { headspa: 45, ikumo: 30, perm: 42, ext: 24 } as const;
export function revisitDays(m: Pick<Menu, "name" | "revisit_days"> | null | undefined, businessType?: string) {
  if (m?.revisit_days && m.revisit_days > 0) return m.revisit_days;
  const n = m?.name || "";
  if (/育毛/.test(n)) return REVISIT_DEFAULTS.ikumo;
  if (/まつげパーマ|まつ毛パーマ|ラッシュリフト|パリジェンヌ|パーマ/.test(n)) return REVISIT_DEFAULTS.perm;
  if (/マツエク|まつげエクステ|まつ毛エクステ|エクステ|付け放題|フラット|ボリュームラッシュ|本/.test(n)) return REVISIT_DEFAULTS.ext;
  if (/スパ/.test(n)) return REVISIT_DEFAULTS.headspa;
  return businessType === "eyelash" ? REVISIT_DEFAULTS.ext : REVISIT_DEFAULTS.headspa;
}
/** 再来案内を送る幅：日数を過ぎてから30日のあいだだけ（オンにした日に昔のお客様へ一斉に送らない） */
export const REVISIT_WINDOW = 30;

// ---------------------------------------------------------------------------
// 文面
// ---------------------------------------------------------------------------
const menuNames = (ids: ID[], menus: Menu[]) => ids.map(id => menus.find(m => m.id === id)).filter((m): m is Menu => !!m && m.category === "technical").map(m => m.name).join("・");

export function buildConfirm(io: Pick<LineIO, "store" | "settings" | "menus">, b: Booking, name: string) {
  const d = jaDate(b.start_at);
  const text = renderTemplate(templateOf("confirm", io.settings.templates), { name, date: d.date, time: d.time, menu: menuNames(b.menu_ids, io.menus) || "ご予約のメニュー", store: io.store.name });
  const msgs = [confirmMessage(text, b.id, `明日のご予約のご確認（${d.date} ${d.time}）`)];
  return { messages: msgs, preview: previewText(msgs) };
}
export function buildRevisit(io: Pick<LineIO, "store" | "settings" | "menus">, name: string, days: number, menuIds: ID[], url: string) {
  const text = renderTemplate(templateOf("revisit", io.settings.templates), { name, store: io.store.name, days, menu: menuNames(menuIds, io.menus), url });
  const msgs = [textMessage(text)];
  return { messages: msgs, preview: previewText(msgs) };
}
export function buildReply(io: Pick<LineIO, "store" | "settings">, key: "ok_reply" | "change_reply" | "ack", name?: string | null) {
  return textMessage(renderTemplate(templateOf(key, io.settings.templates), { name: name || "", store: io.store.name, phone: io.store.phone || "" }));
}

// ---------------------------------------------------------------------------
// Webhook のイベント
// ---------------------------------------------------------------------------
export interface LineEvent {
  type: string; webhookEventId?: string; replyToken?: string; timestamp?: number;
  source?: { type?: string; userId?: string };
  message?: { type?: string; text?: string };
  postback?: { data?: string };
  deliveryContext?: { isRedelivery?: boolean };
}
const ACK_INTERVAL_MS = 12 * 3600_000;

export async function handleEvents(io: LineIO, sender: LineSender, events: LineEvent[]) {
  const out: { type: string; result: string }[] = [];
  const live = io.settings.enabled;
  const reply = async (token: string | undefined, msgs: LineOutMessage[], uid: string, kind: string, customer_id?: ID | null, booking_id?: ID | null) => {
    if (!live || !token) return;
    try { await sender.reply(token, msgs); await io.logMessage({ store_id: io.store.id, line_user_id: uid, customer_id, booking_id, direction: "out", kind, text: previewText(msgs), status: sender.demo ? "demo" : "sent", counted: false }); }
    catch (e) { await io.logMessage({ store_id: io.store.id, line_user_id: uid, customer_id, booking_id, direction: "out", kind, text: previewText(msgs), status: "failed", counted: false, error: String((e as Error).message).slice(0, 300) }); }
  };
  for (const ev of events.slice(0, 100)) {
    const uid = ev.source?.type === "user" ? ev.source.userId : undefined;
    if (!uid || !/^U[0-9a-f]{32}$/.test(uid)) { out.push({ type: ev.type, result: "ignored_source" }); continue; }
    const eid = ev.webhookEventId ? String(ev.webhookEventId).slice(0, 64) : null;
    if (eid && (await io.hasEvent(eid))) { out.push({ type: ev.type, result: "duplicate" }); continue; }
    const now = io.now().toISOString();
    const link = await io.linkByUser(uid);
    const base = { store_id: io.store.id, line_user_id: uid, customer_id: link?.customer_id ?? null, direction: "in" as const, counted: false, event_id: eid };

    if (ev.type === "follow") {
      await io.saveLink({ line_user_id: uid, followed: true, followed_at: now, unfollowed_at: null,
        ...(link?.opt_out_reason === "unfollow" ? { opted_out: false, opt_out_reason: null, opted_out_at: null } : {}) });
      await io.logMessage({ ...base, kind: "follow", text: "友だち追加", status: "received" });
      out.push({ type: "follow", result: "ok" });
    } else if (ev.type === "unfollow") {
      await io.saveLink({ line_user_id: uid, followed: false, unfollowed_at: now, opted_out: true, opt_out_reason: link?.opted_out && link.opt_out_reason ? link.opt_out_reason : "unfollow", opted_out_at: link?.opted_out_at || now });
      await io.logMessage({ ...base, kind: "unfollow", text: "ブロック（友だち解除）", status: "received" });
      out.push({ type: "unfollow", result: "ok" });
    } else if (ev.type === "postback") {
      const pb = parsePostback(ev.postback?.data);
      const b = pb ? await io.booking(pb.bookingId) : null;
      const owns = !!(b && link?.customer_id && b.customer_id === link.customer_id && b.store_id === io.store.id);
      const open = !!b && (b.status === "booked" || b.status === "arrived") && Date.parse(b.end_at) > io.now().getTime();
      if (!pb || !b || !owns) {
        await io.logMessage({ ...base, kind: "postback", text: "前日確認のボタン（予約が見つからない・この方の予約ではない）", status: "received", error: "booking_mismatch" });
        out.push({ type: "postback", result: "mismatch" }); continue;
      }
      if (!open) { await io.logMessage({ ...base, booking_id: b.id, kind: "postback", text: "前日確認のボタン（もう終わった・キャンセル済みの予約）", status: "received" }); out.push({ type: "postback", result: "closed" }); continue; }
      await io.setBookingConfirm(b, pb.answer);
      const name = (link?.customer_id && (await io.customerName(link.customer_id))) || link?.display_name || "";
      const d = jaDate(b.start_at);
      await io.logMessage({ ...base, booking_id: b.id, kind: "postback", text: pb.answer === "ok" ? "予定どおり伺います" : "変更したい", status: "received" });
      if (pb.answer === "change") await io.notifyStaff({ booking_id: b.id, kind: "line_change", subject: `【LINE】予約の変更希望 ${d.date} ${d.time} ${name}様`, body: `${name}様が前日確認で「変更したい」を押しました。\n予約：${d.date} ${d.time}\nお客様へ連絡してください（LINE受信箱・電話）。` });
      await reply(ev.replyToken, [buildReply(io, pb.answer === "ok" ? "ok_reply" : "change_reply", name)], uid, "reply", link?.customer_id, b.id);
      out.push({ type: "postback", result: pb.answer });
    } else if (ev.type === "message") {
      const text = ev.message?.type === "text" ? String(ev.message.text || "").slice(0, 2000) : `（${ev.message?.type || "メッセージ"}）`;
      await io.logMessage({ ...base, kind: "message", text, status: "received" });
      const kw = ev.message?.type === "text" ? optKeyword(text) : null;
      if (kw) {
        await io.saveLink({ line_user_id: uid, opted_out: kw === "stop", opt_out_reason: kw === "stop" ? "customer" : null, opted_out_at: kw === "stop" ? now : null });
        await reply(ev.replyToken, [textMessage(kw === "stop" ? OPT_STOP_REPLY : OPT_RESUME_REPLY)], uid, "optout", link?.customer_id);
        out.push({ type: "message", result: kw }); continue;
      }
      if (!link) await io.saveLink({ line_user_id: uid, followed: true });
      const name = (link?.customer_id && (await io.customerName(link.customer_id))) || link?.display_name || "お客様";
      await io.notifyStaff({ kind: "line_message", subject: `【LINE】${name}からメッセージ`, body: text.slice(0, 500) });
      if (io.settings.ack_enabled) {
        const last = await io.lastOutAt(uid, "ack");
        if (!last || io.now().getTime() - Date.parse(last) > ACK_INTERVAL_MS) await reply(ev.replyToken, [buildReply(io, "ack", name === "お客様" ? "" : name)], uid, "ack", link?.customer_id);
      }
      out.push({ type: "message", result: "stored" });
    } else {
      out.push({ type: ev.type, result: "ignored" });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 送信待ちを作る（Cron から）
// ---------------------------------------------------------------------------
export interface PlanResult { kind: "confirm" | "revisit"; queued: number; skipped: string | null }

/** opt.force：送る時刻を待たない（デモの「テスト送信（デモ）」だけ） */
export async function planConfirm(io: LineIO, opt: { force?: boolean } = {}): Promise<PlanResult> {
  const s = io.settings;
  if (!s.enabled) return { kind: "confirm", queued: 0, skipped: "LINE連携がオフ" };
  if (!s.confirm_enabled) return { kind: "confirm", queued: 0, skipped: "前日確認がオフ" };
  const t = jst(io.now());
  if (!opt.force && t.hm < hm5(s.confirm_time, "18:00")) return { kind: "confirm", queued: 0, skipped: `送る時刻（${hm5(s.confirm_time, "18:00")}）の前` };
  if (!opt.force && t.hm >= CONFIRM_UNTIL) return { kind: "confirm", queued: 0, skipped: "夜は送らない" };
  const tomorrow = addDaysStr(t.date, 1);
  const list = (await io.bookingsOn(tomorrow)).filter(b => b.status === "booked" && b.customer_id && !b.line_confirm && b.channel !== "block");
  const items: Parameters<LineIO["enqueue"]>[0] = [];
  for (const b of list) {
    const link = await io.linkOfCustomer(b.customer_id!);
    if (!linkSendable(link)) continue;
    const name = (await io.customerName(b.customer_id!)) || link!.display_name || "";
    const m = buildConfirm(io, b, name);
    items.push({ store_id: io.store.id, kind: "confirm", dedupe_key: `confirm:${b.id}`, booking_id: b.id, customer_id: b.customer_id, line_user_id: link!.line_user_id, payload: m });
  }
  return { kind: "confirm", queued: items.length ? await io.enqueue(items) : 0, skipped: null };
}

export async function planRevisit(io: LineIO, opt: { max?: number; force?: boolean } = {}): Promise<PlanResult> {
  const s = io.settings;
  if (!s.enabled) return { kind: "revisit", queued: 0, skipped: "LINE連携がオフ" };
  if (!s.revisit_enabled) return { kind: "revisit", queued: 0, skipped: "再来案内がオフ" };
  const t = jst(io.now());
  if (!opt.force && t.hm < hm5(s.revisit_time, "11:00")) return { kind: "revisit", queued: 0, skipped: `送る時刻（${hm5(s.revisit_time, "11:00")}）の前` };
  if (!opt.force && t.hm >= REVISIT_UNTIL) return { kind: "revisit", queued: 0, skipped: "夜は送らない" };
  const room = s.plan_limit - (await io.monthCount());
  if (room <= 0) return { kind: "revisit", queued: 0, skipped: "今月の通数が上限（再来案内は止めています）" };
  const url = io.bookingUrl();
  if (!url) return { kind: "revisit", queued: 0, skipped: "予約ページのURLがありません（設定＞店舗・ネット予約）" };
  if (s.revisit_vacancy_only) {
    const r = await io.vacancyRate(addDaysStr(t.date, 1), 14);
    if (r === null) return { kind: "revisit", queued: 0, skipped: "空き率が分かりません（シフトが未入力）" };
    if (r * 100 < s.vacancy_threshold) return { kind: "revisit", queued: 0, skipped: `この先2週間の空き率 ${Math.round(r * 100)}%（${s.vacancy_threshold}%未満なので見送り）` };
  }
  const links = (await io.sendableLinks()).filter(l => l.customer_id);
  const ids = links.map(l => l.customer_id!) as ID[];
  if (!ids.length) return { kind: "revisit", queued: 0, skipped: null };
  const [visits, future] = await Promise.all([io.lastVisits(ids), io.futureBookingCustomers(ids)]);
  const items: Parameters<LineIO["enqueue"]>[0] = [];
  const cap = Math.min(room, opt.max ?? 100);
  for (const v of visits) {
    if (items.length >= cap) break;
    if (future.has(v.customer_id)) continue;
    const link = links.find(l => l.customer_id === v.customer_id); if (!link) continue;
    const tech = v.menu_ids.map(id => io.menus.find(m => m.id === id)).find(m => m?.category === "technical") || null;
    const interval = revisitDays(tech, io.store.business_type);
    const days = daysBetween(v.date, t.date);
    if (days < interval || days > interval + REVISIT_WINDOW) continue;
    const name = (await io.customerName(v.customer_id)) || link.display_name || "";
    const m = buildRevisit(io, name, days, v.menu_ids, url);
    items.push({ store_id: io.store.id, kind: "revisit", dedupe_key: `revisit:${io.store.id}:${v.customer_id}:${v.date}`, booking_id: null, customer_id: v.customer_id, line_user_id: link.line_user_id, payload: m });
  }
  return { kind: "revisit", queued: items.length ? await io.enqueue(items) : 0, skipped: null };
}

// ---------------------------------------------------------------------------
// 送る（Cron から。デモは送らずにプレビューだけ）
// ---------------------------------------------------------------------------
export async function processQueue(io: LineIO, sender: LineSender, limit = 50) {
  const r = { sent: 0, failed: 0, skipped: 0 };
  const list = await io.queued(limit);
  let count = await io.monthCount();
  for (const q of list) {
    if (!(await io.claim(q.id))) continue;
    const skip = async (why: string) => { await io.finish(q.id, { status: "skipped", error: why }); r.skipped++; };
    if (!io.settings.enabled) { await skip("LINE連携がオフ"); continue; }
    if (q.kind === "confirm" && !io.settings.confirm_enabled) { await skip("前日確認がオフ"); continue; }
    if (q.kind === "revisit" && !io.settings.revisit_enabled) { await skip("再来案内がオフ"); continue; }
    if (q.kind !== "test") {
      const link = await io.linkByUser(q.line_user_id);
      if (!linkSendable(link)) { await skip(link?.opted_out ? "お知らせ停止" : "友だちではない"); continue; }
    }
    if (q.kind === "confirm" && q.booking_id) {
      const b = await io.booking(q.booking_id);
      if (!b || b.status !== "booked" || b.line_confirm) { await skip("予約が変わった（キャンセル・返事済みなど）"); continue; }
    }
    if (q.kind === "revisit" && count >= io.settings.plan_limit) { await skip("今月の通数が上限"); continue; }
    try {
      await sender.push(q.line_user_id, q.payload.messages, q.id);
      await io.finish(q.id, { status: "sent", sent_at: io.now().toISOString(), error: null, attempts: q.attempts + 1 });
      await io.logMessage({ store_id: io.store.id, line_user_id: q.line_user_id, customer_id: q.customer_id ?? null, booking_id: q.booking_id ?? null, direction: "out", kind: q.kind, text: q.payload.preview, status: sender.demo ? "demo" : "sent", counted: !sender.demo });
      if (!sender.demo) count++;
      r.sent++;
    } catch (e) {
      const attempts = q.attempts + 1;
      await io.finish(q.id, { status: attempts >= 3 ? "failed" : "queued", attempts, error: String((e as Error).message).slice(0, 300) });
      if (attempts >= 3) await io.logMessage({ store_id: io.store.id, line_user_id: q.line_user_id, customer_id: q.customer_id ?? null, booking_id: q.booking_id ?? null, direction: "out", kind: q.kind, text: q.payload.preview, status: "failed", counted: false, error: String((e as Error).message).slice(0, 300) });
      r.failed++;
    }
  }
  return r;
}

/** Cron 1回分：前日確認 → 再来案内 → 送信 */
export async function runCron(io: LineIO, sender: LineSender, opt: { force?: boolean } = {}) {
  const plans = [await planConfirm(io, opt), await planRevisit(io, opt)];
  const sent = await processQueue(io, sender);
  return { plans, ...sent };
}

/** 月の通数の状態（画面の注意） */
export function quotaState(used: number, limit: number) {
  if (limit <= 0) return { pct: 100, level: "stop" as const };
  const r = used / limit;
  return { pct: Math.floor(r * 100), level: r >= 1 ? ("stop" as const) : r >= 0.8 ? ("warn" as const) : ("ok" as const) };
}

/** 試し送信・プレビュー用の見本 */
export function sampleMessages(io: Pick<LineIO, "store" | "settings" | "menus">, key: "confirm" | "revisit" | "ok_reply" | "change_reply" | "ack", url: string | null) {
  const tech = io.menus.find(m => m.category === "technical");
  const start = new Date(io.settings ? Date.now() + 86400_000 : Date.now()); start.setUTCHours(5, 0, 0, 0);
  const fake: Booking = { id: "00000000-0000-0000-0000-000000000000", store_id: io.store.id, start_at: start.toISOString(), end_at: start.toISOString(), status: "booked", channel: "own", menu_ids: tech ? [tech.id] : [], nominated: false, created_at: "", updated_at: "" };
  if (key === "confirm") return buildConfirm(io, fake, "（お名前）").messages;
  if (key === "revisit") return buildRevisit(io, "（お名前）", revisitDays(tech, io.store.business_type), tech ? [tech.id] : [], url || "https://（予約ページのURL）").messages;
  return [buildReply(io, key, "（お名前）")];
}
