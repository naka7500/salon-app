// 公式ネット予約（お客様用）と、メニュー・クーポンの共通ロジック。
// 本番は Supabase の public_* 関数（SECURITY DEFINER）を呼ぶ。デモは memory.ts の webApi が同じ計算をこのファイルで行う。
// ※空き時間の計算（webSlots）は 0007_phase_c.sql の _web_slots と同じ条件にそろえること。
import type { Booking, Coupon, CouponKind, IntakeAnswer, IntakeQuestion, Lane, Menu, Shift, Staff, Store, Target } from "@/lib/db/types";

// ---------- お客様用ページに渡す形 ----------
export interface PublicStore {
  slug: string; name: string; name_en?: string|null; business_type: Store["business_type"]; phone?: string|null; address?: string|null;
  logo_url?: string|null; photo_url?: string|null; web_message?: string|null; cancel_policy?: string|null;
  cancel_deadline_days: number; cancel_deadline_time: string; booking_horizon_days: number; slot_minutes: number;
  intake_questions?: IntakeQuestion[]|null; today: string;
}
export interface PublicMenu { id: string; name: string; name_en?: string|null; description?: string|null; description_en?: string|null; image_url?: string|null; price: number; duration_min: number; target: Target; nominatable: boolean; people: number; color?: string|null }
export interface PublicCoupon { id: string; name: string; name_en?: string|null; description?: string|null; description_en?: string|null; kind: CouponKind; value: number; menu_ids: string[]; target: Target; within_days?: number|null; weekdays?: number[]|null; time_from?: string|null; time_to?: string|null; has_code: boolean; left?: number|null }
export interface PublicCatalog { menus: PublicMenu[]; coupons: PublicCoupon[]; staff: { id: string; name: string }[] }
export interface PublicAvailability { days: Record<string, string[]> }
export interface PublicBookingInput { slug: string; menu_id: string; start_at: string; name: string; kana: string; phone: string; email: string; intake: IntakeAnswer[]; coupon_id?: string|null; code?: string|null; staff_id?: string|null; lang: "ja"|"en" }
export interface PublicBookingResult { booking_no: string; cancel_token: string; start_at: string; end_at: string; menu_name: string; menu_name_en?: string|null; price: number; people: number; store_name: string; staff_name?: string|null; coupon_name?: string|null; deadline: string }
export interface PublicBookingView { booking_no: string; status: Booking["status"]; start_at: string; end_at: string; menu_name?: string|null; menu_name_en?: string|null; price?: number|null; store_name: string; store_phone?: string|null; slug: string; customer_name?: string|null; deadline: string; cancellable: boolean }

export interface PublicApi {
  mode: "memory"|"supabase";
  /** null＝店舗が無い・ネット予約を開けていない。0007未適用は Error('not_ready') */
  storeInfo(slug: string): Promise<PublicStore|null>;
  menus(slug: string, code?: string|null): Promise<PublicCatalog|null>;
  availability(slug: string, menuId: string, from: string, to: string, couponId?: string|null, staffId?: string|null): Promise<PublicAvailability|null>;
  createBooking(input: PublicBookingInput): Promise<PublicBookingResult>;
  bookingByToken(token: string): Promise<PublicBookingView|null>;
  cancelBooking(token: string): Promise<{ ok: boolean; booking_no?: string|null }>;
}

let api: PublicApi | null = null;
export function getPublicApi(): PublicApi {
  if (api) return api;
  if (process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    api = (require("./db/supabase") as typeof import("./db/supabase")).supabasePublicApi;
  } else {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    api = (require("./db/memory") as typeof import("./db/memory")).memoryPublicApi;
  }
  return api;
}

// ---------- クーポン ----------
export const COUPON_KIND_LABEL: Record<CouponKind, string> = { amount: "金額値引", percent: "率値引", fixed: "特別価格" };
export const TARGET_LABEL: Record<Target, string> = { all: "全員", new: "新規のみ", repeat: "再来のみ" };
export const WD_JA = ["日", "月", "火", "水", "木", "金", "土"];
export const WD_EN = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** クーポン適用後の料金（1名分・税込）。SQL の _coupon_price と同じ */
export function couponPrice(kind: CouponKind, value: number, base: number) {
  if (kind === "amount") return Math.max(0, base - value);
  if (kind === "percent") return base - Math.floor((base * value) / 100);
  if (kind === "fixed") return value;
  return base;
}
/** このクーポンが使えるメニューか（menu_ids が空＝技術メニュー全部） */
export function couponAppliesTo(c: Pick<Coupon, "menu_ids">, m: Pick<Menu, "id"|"category">) {
  return c.menu_ids.length ? c.menu_ids.includes(m.id) : m.category === "technical";
}
const sameWeekdays = (a: number[], b: number[]) => a.length === b.length && a.every(x => b.includes(x));
/** 条件の短い説明（日本語） */
export function couponConditions(c: Pick<Coupon, "target"|"within_days"|"weekdays"|"time_from"|"time_to"|"first_n"|"per_customer_limit"|"code">, lang: "ja"|"en" = "ja") {
  const out: string[] = [];
  const en = lang === "en";
  if (c.target === "new") out.push(en ? "First visit only" : "新規の方限定");
  if (c.target === "repeat") out.push(en ? "Returning guests only" : "再来の方限定");
  if (c.within_days) out.push(en ? `Within ${c.within_days} days of your last visit` : `前回来店から${c.within_days}日以内`);
  const wd = c.weekdays || [];
  if (wd.length) out.push(sameWeekdays(wd, [1, 2, 3, 4, 5]) ? (en ? "Weekdays only" : "平日限定") : sameWeekdays(wd, [0, 6]) ? (en ? "Weekends only" : "土日限定") : (en ? `${wd.map(d => WD_EN[d]).join("/")} only` : `${wd.map(d => WD_JA[d]).join("・")}曜限定`));
  if (c.time_from || c.time_to) out.push(en ? `Start ${c.time_from || ""}–${c.time_to || ""}` : `${c.time_from || ""}〜${c.time_to || ""}の来店`);
  if (c.first_n) out.push(en ? `First ${c.first_n} guests` : `先着${c.first_n}名`);
  if (c.per_customer_limit) out.push(en ? `Up to ${c.per_customer_limit} use(s) per person` : `お一人様${c.per_customer_limit}回まで`);
  if (c.code) out.push(en ? "Coupon code required" : "クーポンコードが必要");
  return out;
}
/** HPBの文字数の目安（サロンボードの入力欄。超えたら切る）。HPB側の仕様が変わったらここを直す */
export const HPB_LIMIT = { name: 40, description: 120 };
/** HPB（サロンボード）のクーポンと名称・説明をそろえるための文言 */
export function hpbCopyText(c: Coupon, menus: Menu[]) {
  const prefix = c.target === "new" ? "【新規】" : c.target === "repeat" ? "【再来】" : "【全員】";
  const cut = (s: string, n: number) => { const a = Array.from(s); return a.length > n ? a.slice(0, n - 1).join("") + "…" : s; };
  const name = cut(c.name.startsWith("【") ? c.name : prefix + c.name, HPB_LIMIT.name);
  const targets = c.menu_ids.length ? menus.filter(m => c.menu_ids.includes(m.id)) : [];
  const price = targets.length === 1 ? `${couponPrice(c.kind, c.value, targets[0].price).toLocaleString()}円（通常${targets[0].price.toLocaleString()}円）` : c.kind === "amount" ? `${c.value.toLocaleString()}円引き` : c.kind === "percent" ? `${c.value}%オフ` : `${c.value.toLocaleString()}円`;
  const conds = couponConditions(c).filter(x => x !== "クーポンコードが必要");
  const descBase = [c.description || "", conds.length ? `※${conds.join("・")}` : ""].filter(Boolean).join(" ");
  const description = cut(descBase, HPB_LIMIT.description);
  return { name, description, price, text: `クーポン名：${name}\n説明：${description}\n価格：${price}${targets.length ? `\n対象メニュー：${targets.map(m => m.name).join("、")}` : ""}`, nameLen: Array.from(name).length, descLen: Array.from(description).length };
}

// ---------- 事前問診（業態別テンプレ） ----------
export const DEFAULT_INTAKE: Record<Store["business_type"], IntakeQuestion[]> = {
  headspa: [
    { id: "scalp", label: "頭皮・髪のお悩み", label_en: "Scalp / hair concerns", type: "multi", options: ["かゆみ", "乾燥・フケ", "べたつき", "抜け毛", "白髪", "頭のこり・頭痛", "特になし"], options_en: ["Itchiness", "Dryness / dandruff", "Oiliness", "Hair loss", "Gray hair", "Tension / headache", "None"] },
    { id: "sleep", label: "最近の睡眠", label_en: "Recent sleep", type: "choice", options: ["よく眠れている", "寝つきが悪い", "途中で目が覚める", "眠りが浅い"], options_en: ["Sleeping well", "Hard to fall asleep", "Wake up at night", "Light sleep"] },
    { id: "allergy", label: "アレルギー・肌の弱さ（あれば）", label_en: "Allergies / sensitive skin (if any)", type: "text" },
    { id: "wish", label: "当日のご希望（力加減・眠りたい など）", label_en: "Requests for the day (pressure, want to sleep, etc.)", type: "textarea" },
  ],
  eyelash: [
    { id: "contact", label: "コンタクトレンズ", label_en: "Contact lenses", type: "choice", options: ["使っていない", "ソフト", "ハード", "当日は外して来店"], options_en: ["None", "Soft", "Hard", "Will remove before visit"], required: true },
    { id: "trouble", label: "過去のトラブル（かぶれ・しみる など）", label_en: "Past trouble (irritation, stinging, etc.)", type: "choice", options: ["なし", "あり"], options_en: ["None", "Yes"], required: true },
    { id: "allergy", label: "アレルギー（グルー・薬剤など）", label_en: "Allergies (glue, chemicals, etc.)", type: "text" },
    { id: "design", label: "希望のデザイン・長さ", label_en: "Preferred design / length", type: "textarea" },
  ],
  hair: [
    { id: "trouble", label: "頭皮・肌のトラブル", label_en: "Scalp / skin trouble", type: "text" },
    { id: "wish", label: "ご希望", label_en: "Requests", type: "textarea" },
  ],
};
export function intakeQuestionsFor(store: Pick<Store, "business_type"|"intake_questions">) {
  return store.intake_questions && store.intake_questions.length ? store.intake_questions : DEFAULT_INTAKE[store.business_type] || DEFAULT_INTAKE.hair;
}

// ---------- 空き時間の計算（デモ用。SQL の _web_slots と同じ条件） ----------
const toMin = (t?: string|null) => { if (!t) return 0; const [h, m] = t.split(":").map(Number); return h * 60 + (m || 0); };
const pad = (n: number) => String(n).padStart(2, "0");
const ymdLocal = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const hmLocal = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
export function publishedNow(from?: string|null, to?: string|null, today = ymdLocal(new Date())) { return (!from || from <= today) && (!to || to >= today); }

/** メニューが使う受付枠と、1件で何名分か（1名様枠以外で capacity 2 以上の枠＝ペア＝2名） */
export function menuLane(lanes: Lane[], laneId?: string|null) {
  const act = lanes.filter(l => l.active).sort((a, b) => a.sort_order - b.sort_order || a.id.localeCompare(b.id));
  if (!act.length) return null;
  const lane = act.find(l => l.id === laneId) || act[0];
  return { lane, people: lane.capacity >= 2 && lane.id !== act[0].id ? 2 : 1 };
}

export interface SlotInput { store: Store; menu: Menu; coupon?: Coupon|null; lanes: Lane[]; shifts: Shift[]; bookings: Booking[]; staff: Staff[]; date: string; staffId?: string|null; now?: Date }
/** 1日分の空き（開始時刻と、割り当てる担当＝その日の予約が少ない順） */
export function webSlots(i: SlotInput): { start: Date; staffIds: string[] }[] {
  const { store, menu: m, coupon: cp, date } = i;
  const now = i.now || new Date(); const today = ymdLocal(now);
  const horizon = new Date(`${today}T00:00:00`); horizon.setDate(horizon.getDate() + (store.booking_horizon_days ?? 60));
  if (date < today || date > ymdLocal(horizon)) return [];
  if (!m.active || m.web_visible === false || m.category !== "technical" || !publishedNow(m.publish_from, m.publish_to, today)) return [];
  const wd = new Date(`${date}T00:00:00`).getDay();
  if (m.weekdays?.length && !m.weekdays.includes(wd)) return [];
  if (cp && (!cp.active || (cp.weekdays?.length && !cp.weekdays.includes(wd)))) return [];
  if (i.staffId && m.nominatable === false) return [];
  const ml = menuLane(i.lanes, m.lane_id); if (!ml) return [];
  const step = Math.max(5, store.slot_minutes || 15);
  const dur = m.duration_min, blk = m.duration_min + (m.interval_min || 0);
  const lead = new Date(now.getTime() + (store.booking_lead_min ?? 60) * 60000);
  const dayStart = new Date(`${date}T00:00:00`), dayEnd = new Date(dayStart); dayEnd.setDate(dayEnd.getDate() + 1);
  const T = (iso: string) => new Date(iso).getTime();
  const dayShifts = i.shifts.filter(s => s.date === date && s.staff_id);
  const hasShift = dayShifts.length > 0;
  const live = (b: Booking) => b.status === "booked" || b.status === "arrived" || b.status === "done";
  const overlaps = (b: Booking, s: number, e: number) => T(b.start_at) < e && T(b.end_at) > s;
  const idles = i.bookings.filter(b => b.lane_id === ml.lane.id && b.status === "block" && b.block_kind === "idle" && T(b.start_at) < dayEnd.getTime() && T(b.end_at) > dayStart.getTime()).sort((a, b) => a.start_at.localeCompare(b.start_at));
  const out: { start: Date; staffIds: string[] }[] = []; let prev = -Infinity;
  for (const idle of idles) {
    const fromMin = Math.ceil((T(idle.start_at) - dayStart.getTime()) / 60000 / step) * step;
    for (let tm = fromMin; dayStart.getTime() + tm * 60000 < T(idle.end_at); tm += step) {
      const t = dayStart.getTime() + tm * 60000;
      if (t <= prev || t < lead.getTime()) continue;
      const tl = new Date(t), te = new Date(t + dur * 60000);
      if (ymdLocal(tl) !== date) continue;
      const tH = hmLocal(tl);
      if (m.time_from && tH < m.time_from.slice(0, 5)) continue;
      if (m.time_to && tH > m.time_to.slice(0, 5)) continue;
      if (cp && ((cp.time_from && tH < cp.time_from.slice(0, 5)) || (cp.time_to && tH > cp.time_to.slice(0, 5)))) continue;
      if (i.bookings.some(b => b.lane_id === ml.lane.id && b.status === "block" && b.block_kind === "close" && overlaps(b, t, t + dur * 60000))) continue;
      const used = i.bookings.filter(b => b.lane_id === ml.lane.id && live(b) && overlaps(b, t, t + blk * 60000)).length;
      if (used + ml.people > ml.lane.capacity) continue;
      const teH = hmLocal(te); const tlM = toMin(tH), teM = toMin(teH);
      const free = i.staff.filter(s => s.active && (!i.staffId || s.id === i.staffId)).filter(s => {
        if (hasShift) {
          const sh = dayShifts.find(x => x.staff_id === s.id && x.kind === "work" && x.start_time && x.end_time);
          if (!sh) return false;
          if (tlM < toMin(sh.start_time) || teM > toMin(sh.end_time) || ymdLocal(te) !== date) return false;
          if (sh.break_start && sh.break_end && tlM < toMin(sh.break_end) && teM > toMin(sh.break_start)) return false;
        }
        return !i.bookings.some(b => b.staff_id === s.id && (live(b) || (b.status === "block" && b.block_kind !== "idle")) && overlaps(b, t, t + blk * 60000));
      }).map(s => ({ id: s.id, n: i.bookings.filter(b => b.staff_id === s.id && live(b) && T(b.start_at) >= dayStart.getTime() && T(b.start_at) < dayEnd.getTime()).length }))
        .sort((a, b) => a.n - b.n || a.id.localeCompare(b.id)).map(x => x.id);
      const unassigned = i.bookings.filter(b => !b.staff_id && live(b) && overlaps(b, t, t + blk * 60000)).length;
      if (free.length - unassigned < ml.people) continue;
      out.push({ start: tl, staffIds: free.slice(0, ml.people) }); prev = t;
    }
  }
  return out;
}

/** キャンセル期限（予約日の cancel_deadline_days 日前の cancel_deadline_time） */
export function cancelDeadline(store: Pick<Store, "cancel_deadline_days"|"cancel_deadline_time">, startIso: string) {
  const d = new Date(startIso); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - (store.cancel_deadline_days ?? 1));
  const [h, mi] = (store.cancel_deadline_time || "18:00").split(":").map(Number); d.setHours(h, mi || 0, 0, 0);
  return d;
}
export const normPhone = (p: string) => { const d = (p || "").replace(/[^0-9]/g, ""); return /^81[0-9]{9,10}$/.test(d) ? "0" + d.slice(2) : d; };

/** 予約ページのエラーコード → お客様向けの文 */
export const ERROR_TEXT: Record<string, { ja: string; en: string }> = {
  slot_taken: { ja: "申し訳ありません。この時間はたった今埋まりました。別の時間をお選びください。", en: "Sorry, this time was just taken. Please choose another time." },
  too_many: { ja: "短い時間に予約が集中しています。お手数ですがお電話でご予約ください。", en: "Too many requests. Please call the salon to book." },
  duplicate: { ja: "同じ時間のご予約がすでにあります。", en: "You already have a booking at this time." },
  invalid_name: { ja: "お名前を入れてください。", en: "Please enter your name." },
  invalid_kana: { ja: "フリガナを入れてください。", en: "Please enter your name reading." },
  invalid_phone: { ja: "電話番号を確認してください。", en: "Please check your phone number." },
  invalid_email: { ja: "メールアドレスを確認してください。", en: "Please check your email address." },
  invalid_intake: { ja: "問診の回答が長すぎます。", en: "Your answers are too long." },
  menu_new_only: { ja: "このメニューは初めての方限定です。", en: "This menu is for first-time guests only." },
  menu_repeat_only: { ja: "このメニューは再来の方限定です。", en: "This menu is for returning guests only." },
  coupon_invalid: { ja: "このクーポンは今は使えません。", en: "This coupon is not available." },
  coupon_code: { ja: "クーポンコードが違います。", en: "The coupon code is incorrect." },
  coupon_menu: { ja: "このクーポンはこのメニューには使えません。", en: "This coupon does not apply to this menu." },
  coupon_new_only: { ja: "このクーポンは初めての方限定です（ご来店歴があるため使えません）。", en: "This coupon is for first-time guests only." },
  coupon_repeat_only: { ja: "このクーポンは再来の方限定です（ご来店歴が見つかりませんでした）。", en: "This coupon is for returning guests only." },
  coupon_within_days: { ja: "このクーポンは前回のご来店から決められた日数以内の方限定です。", en: "This coupon is only valid within a set number of days since your last visit." },
  coupon_sold_out: { ja: "このクーポンは先着の人数に達しました。", en: "This coupon has reached its limit." },
  coupon_limit: { ja: "このクーポンの利用回数の上限に達しています。", en: "You have reached the usage limit for this coupon." },
  deadline_passed: { ja: "キャンセル期限を過ぎています。お手数ですが店舗にお電話ください。", en: "The cancellation deadline has passed. Please call the salon." },
  already_cancelled: { ja: "このご予約はキャンセル済みです。", en: "This booking has already been cancelled." },
  not_cancellable: { ja: "このご予約はキャンセルできません。店舗にお電話ください。", en: "This booking cannot be cancelled online. Please call the salon." },
  not_found: { ja: "ご予約が見つかりません。", en: "Booking not found." },
  store_not_found: { ja: "店舗が見つかりません。", en: "Salon not found." },
  not_ready: { ja: "ネット予約は準備中です。", en: "Online booking is coming soon." },
};
export function errorText(e: unknown, lang: "ja"|"en") {
  const msg = (e as Error)?.message || String(e);
  const code = Object.keys(ERROR_TEXT).find(k => msg.includes(k));
  return code ? ERROR_TEXT[code][lang] : (lang === "en" ? "Something went wrong. Please try again." : "うまくいきませんでした。もう一度お試しください。") + (msg ? `（${msg.slice(0, 80)}）` : "");
}
