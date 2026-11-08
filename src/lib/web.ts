// 公式ネット予約（お客様用）と、メニュー・クーポンの共通ロジック。
// 本番は Supabase の public_* 関数（SECURITY DEFINER）を呼ぶ。デモは memory.ts の webApi が同じ計算をこのファイルで行う。
// ※空き時間の計算（webSlots）は 0009_options_pair.sql の _web_slots（人数×部屋）と同じ条件にそろえること。
import type { Booking, Coupon, CouponKind, IntakeAnswer, IntakeQuestion, Lane, Menu, OptionGroup, Shift, Staff, Store, Target } from "@/lib/db/types";

// ---------- お客様用ページに渡す形 ----------
export interface PublicStore {
  slug: string; name: string; name_en?: string|null; business_type: Store["business_type"]; phone?: string|null; address?: string|null;
  logo_url?: string|null; photo_url?: string|null; web_message?: string|null; cancel_policy?: string|null;
  cancel_deadline_days: number; cancel_deadline_time: string; booking_horizon_days: number; slot_minutes: number;
  intake_questions?: IntakeQuestion[]|null; today: string;
}
export interface PublicMenu { id: string; name: string; name_en?: string|null; description?: string|null; description_en?: string|null; image_url?: string|null; price: number; duration_min: number; target: Target; nominatable: boolean; people: number; color?: string|null;
  /** 0009：付けられるオプショングループ。price_per='group'＝ペアの料金は1組の料金（0009より前は1名分） */
  option_group_ids?: string[]; price_per?: "group"|"person";
  /** 0018：クーポン専用（coupon_menus にだけ入る。メニュー欄には出さない） */
  coupon_only?: boolean }
export interface PublicOptionItem { id: string; name: string; name_en?: string|null; description?: string|null; price: number; minutes: number }
export interface PublicOptionGroup { id: string; name: string; name_en?: string|null; description?: string|null; required: boolean; multi: boolean; items: PublicOptionItem[] }
export interface PublicCoupon { id: string; name: string; name_en?: string|null; description?: string|null; description_en?: string|null; kind: CouponKind; value: number; menu_ids: string[]; target: Target; within_days?: number|null; weekdays?: number[]|null; time_from?: string|null; time_to?: string|null; has_code: boolean; left?: number|null; option_group_ids?: string[] }
/** staff：指名できる人（name＝表示名。fee＝指名料・円。0008未適用のDBでは name_en/fee なし） */
export interface PublicStaff { id: string; name: string; name_en?: string|null; fee?: number|null }
export interface PublicCatalog { menus: PublicMenu[]; coupons: PublicCoupon[]; staff: PublicStaff[]; option_groups?: PublicOptionGroup[];
  /** 0018：掲載中のクーポンが対象にしているクーポン専用メニュー（クーポンの選択肢にだけ使う。0018 未適用のDBでは無い） */
  coupon_menus?: PublicMenu[] }
export interface PublicAvailability { days: Record<string, string[]> }
export interface PublicBookingInput { slug: string; menu_id: string; start_at: string; name: string; kana: string; phone: string; email: string; intake: IntakeAnswer[]; coupon_id?: string|null; code?: string|null; staff_id?: string|null; lang: "ja"|"en"; option_ids?: string[] }
export interface PublicBookingResult { booking_no: string; cancel_token: string; start_at: string; end_at: string; menu_name: string; menu_name_en?: string|null; price: number; people: number; store_name: string; staff_name?: string|null; coupon_name?: string|null; deadline: string;
  /** 0009：合計（1組・オプション・指名料込み）とオプション名 */ price_total?: number; options_label?: string|null }
export interface PublicBookingView { booking_no: string; status: Booking["status"]; start_at: string; end_at: string; menu_name?: string|null; menu_name_en?: string|null; price?: number|null; store_name: string; store_phone?: string|null; slug: string; customer_name?: string|null; deadline: string; cancellable: boolean }

export interface PublicApi {
  mode: "memory"|"supabase";
  /** null＝店舗が無い・ネット予約を開けていない。0007未適用は Error('not_ready') */
  storeInfo(slug: string): Promise<PublicStore|null>;
  menus(slug: string, code?: string|null): Promise<PublicCatalog|null>;
  availability(slug: string, menuId: string, from: string, to: string, couponId?: string|null, staffId?: string|null, optionIds?: string[]): Promise<PublicAvailability|null>;
  createBooking(input: PublicBookingInput): Promise<PublicBookingResult>;
  bookingByToken(token: string): Promise<PublicBookingView|null>;
  cancelBooking(token: string): Promise<{ ok: boolean; booking_no?: string|null }>;
  /** LINE連携（0015）：この店の LIFF ID（LINE連携がオンの店だけ）。無ければ null */
  lineInfo?(slug: string): Promise<{ liff_id: string; basic_id?: string|null }|null>;
  /** LIFF からお客様の LINE をつなぐ（本番は /api/line/link。デモは端末の中でつなぐ） */
  lineMe?(body: { slug: string; idToken: string }): Promise<{ found: boolean; name?: string; kana?: string; phone?: string; email?: string }>;
  /** 会計のQR（token）だけ。LINE予約からの連携は lineBook が予約と一緒に行う（0022・案B） */
  linkLine?(body: { slug: string; idToken: string; mode: "token"; token: string }): Promise<{ ok: boolean; name?: string|null; basic_id?: string|null; message?: string }>;
  /** 0022（案B）：LINEの中の予約の確定。LINEのユーザーIDが本人（電話番号では既存のお客様につながない）。本番は /api/line/book、デモは端末の中 */
  lineBook?(body: PublicBookingInput & { idToken: string }): Promise<PublicBookingResult & { line: { linked: boolean; customer_created: boolean } }>;
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
/** 0018：ネット予約でこのメニューを予約できるか。クーポン専用のメニューは、そのメニューを対象（menu_ids）に入れたクーポンのときだけ。
 *  （「全メニュー対象」＝menu_ids が空のクーポンでは予約できない。SQL の public_create_booking／_web_slots と同じ条件） */
export function webBookableWith(m: { id: string; coupon_only?: boolean|null }, c?: { menu_ids?: string[]|null }|null) {
  return !m.coupon_only || !!c && (c.menu_ids || []).includes(m.id);
}
/** 0018：予約ページの「メニュー」タブに出すメニュー（クーポン専用は出さない） */
export function catalogMenuTab(cat: Pick<PublicCatalog, "menus">): PublicMenu[] { return cat.menus.filter(m => !m.coupon_only); }
/** 0018：このクーポンで選べるメニュー。menu_ids が空＝メニュー欄の全部、指定あり＝指定の順（クーポン専用のメニューも含む） */
export function catalogCouponMenus(cat: Pick<PublicCatalog, "menus"|"coupon_menus">, c: Pick<PublicCoupon, "menu_ids">): PublicMenu[] {
  const tab = catalogMenuTab(cat);
  if (!c.menu_ids.length) return tab;
  const all = [...cat.menus, ...(cat.coupon_menus || [])];
  return all.filter((m, i) => c.menu_ids.includes(m.id) && all.findIndex(x => x.id === m.id) === i && webBookableWith(m, c));
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

// ---------- 空き時間の計算（v1.1：人数×部屋。SQL の _web_slots（0009）と同じ条件） ----------
const toMin = (t?: string|null) => { if (!t) return 0; const [h, m] = t.split(":").map(Number); return h * 60 + (m || 0); };
const pad = (n: number) => String(n).padStart(2, "0");
const ymdLocal = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const hmLocal = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
export function publishedNow(from?: string|null, to?: string|null, today = ymdLocal(new Date())) { return (!from || from <= today) && (!to || to >= today); }

/** メニューが使う受付枠と、1件で何名分か（1名様枠以外で capacity 2 以上の枠＝ペア＝2名）。0009 より前の判定 */
export function menuLane(lanes: Lane[], laneId?: string|null) {
  const act = lanes.filter(l => l.active).sort((a, b) => a.sort_order - b.sort_order || a.id.localeCompare(b.id));
  if (!act.length) return null;
  const lane = act.find(l => l.id === laneId) || act[0];
  return { lane, people: lane.capacity >= 2 && lane.id !== act[0].id ? 2 : 1 };
}
/** メニューの人数（1名様／2名＝ペア）。0009 の menus.people、未適用DBは受付枠から判定 */
export function menuPeople(m: Pick<Menu, "people"|"lane_id">|null|undefined, lanes: Lane[]) {
  if (!m) return 1;
  return m.people ?? menuLane(lanes, m.lane_id)?.people ?? 1;
}
/** 1名様枠（一番上）とペア枠（capacity 2 以上の別の枠） */
export function laneIds(lanes: Lane[]) {
  const act = lanes.filter(l => l.active).sort((a, b) => a.sort_order - b.sort_order || a.id.localeCompare(b.id));
  const first = act[0]?.id ?? null;
  const pair = act.find(l => l.id !== first && l.capacity >= 2)?.id ?? null;
  return { first, pair };
}

// ---------- オプション（0009） ----------
export interface OptionChoice { group: OptionGroup; items: Menu[] }
/** このメニュー（＋クーポン）で選べるオプショングループと選択肢。webOnly＝ネット予約に出すものだけ */
export function optionChoices(menu: Pick<Menu, "option_group_ids">|null|undefined, coupon: Pick<Coupon, "option_group_ids">|null|undefined, groups: OptionGroup[], menus: Menu[], webOnly = false): OptionChoice[] {
  if (!menu) return [];
  const ids = new Set([...(menu.option_group_ids || []), ...(coupon?.option_group_ids || [])]);
  return groups.filter(g => g.active && ids.has(g.id)).sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name, "ja"))
    .map(g => ({ group: g, items: menus.filter(x => x.category === "option" && x.active && x.option_group_id === g.id && (!webOnly || x.web_visible !== false)).sort((a, b) => a.sort_order - b.sort_order) }))
    .filter(c => c.items.length > 0);
}
/** 選んだオプションの確認。問題があればエラーコード（option_required／option_single／option_invalid） */
export function optionError(choices: OptionChoice[], selected: string[]): string|null {
  const all = new Set(choices.flatMap(c => c.items.map(i => i.id)));
  if (selected.some(id => !all.has(id))) return "option_invalid";
  for (const c of choices) {
    const n = c.items.filter(i => selected.includes(i.id)).length;
    if (c.group.required && n === 0) return "option_required";
    if (!c.group.multi && n > 1) return "option_single";
  }
  return null;
}
/** 選んだオプションの合計（追加時間・追加料金） */
export function optionTotals(ids: string[], menus: Menu[]) {
  const xs = ids.map(id => menus.find(m => m.id === id)).filter((m): m is Menu => !!m && m.category === "option");
  return { minutes: xs.reduce((a, m) => a + (m.duration_min || 0), 0), price: xs.reduce((a, m) => a + (m.price || 0), 0), items: xs };
}
/** 予約の表示名：「エクステ80本＋他店オフ」（技術は「・」、オプションは「＋」でつなぐ） */
export function bookingMenuLabel(menuIds: string[], menus: Menu[], short = false) {
  const ms = menuIds.map(id => menus.find(m => m.id === id)).filter((m): m is Menu => !!m);
  const nm = (m: Menu) => (short ? m.short_name || m.name : m.name);
  const tech = ms.filter(m => m.category !== "option").map(nm).join("・");
  const opts = ms.filter(m => m.category === "option").map(m => m.name);
  return [tech, ...opts].filter(Boolean).join("＋");
}
/** 予約1行の売上見込み。ペア（2名）の技術メニューは「1組」の料金なので、1行あたり半分 */
export function bookingValue(b: Pick<Booking, "menu_ids"|"pair_group">, menus: Menu[]) {
  return b.menu_ids.reduce((a, id) => { const m = menus.find(x => x.id === id); if (!m) return a; const ppl = m.category === "technical" && (m.people ?? 1) > 1 ? (m.people ?? 1) : 1; return a + m.price / ppl; }, 0);
}
/** ペアの売上の分け方（今は半分ずつ。店舗設定にするのは後で） */
export const PAIR_SPLIT = 0.5;

// ---------- 人数×部屋 ----------
export interface HeadsCtx { store: Store; lanes: Lane[]; shifts: Shift[]; bookings: Booking[]; staff: Staff[]; date: string;
  /** 数えない予約（電話予約を編集中の自分など） */ excludeIds?: string[] }
const liveB = (b: Booking) => b.status === "booked" || b.status === "arrived" || b.status === "done";
/** 担当として数える人（在籍・台帳に表示・閲覧のみ以外） */
const canServe = (s: Staff) => s.active !== false && s.show_on_ledger !== false && s.role !== "viewer";
/** t（ミリ秒）から dur 分の施術（占有は blk 分）で：空いている担当（その日の予約が少ない順）・残り人数・出勤中の人数。
 *  条件：出勤中（施術がシフト内に収まる・休憩と重ならない）、予約・ブロック（IDLE以外）が重ならない。
 *  残り＝空いている担当 −担当なしの予約、部屋数があれば「部屋数−使用中」と小さい方。
 *  その日にシフトが1件も無い店は、受付枠IDLEの中だけ・在籍の全員で数える（0009 より前と同じ）。 */
export function headsAt(c: HeadsCtx, t: number, dur: number, blk: number, o: { lastOrder?: boolean; idleLaneId?: string|null } = {}) {
  const ex = new Set(c.excludeIds || []);
  const bs = c.bookings.filter(b => !ex.has(b.id) && b.status !== "cancelled");
  const T = (iso: string) => new Date(iso).getTime();
  const over = (b: Booking, s: number, e: number) => T(b.start_at) < e && T(b.end_at) > s;
  const dayShifts = c.shifts.filter(s => s.date === c.date && s.staff_id);
  const hasShift = dayShifts.length > 0;
  const tl = new Date(t), te = new Date(t + dur * 60000);
  const tlM = toMin(hmLocal(tl)), teM = ymdLocal(te) === c.date ? toMin(hmLocal(te)) : 24 * 60;
  const lastOff = o.lastOrder ? c.store.last_order_offset_min ?? null : null;
  if (!hasShift) {
    const lane = o.idleLaneId ?? laneIds(c.lanes).first;
    if (!bs.some(b => b.lane_id === lane && b.status === "block" && b.block_kind === "idle" && T(b.start_at) <= t && T(b.end_at) > t)) return { free: [] as string[], left: 0, onShift: 0 };
  }
  const dayStart = new Date(`${c.date}T00:00:00`).getTime(), dayEnd = dayStart + 86400000;
  const onShift = c.staff.filter(canServe).filter(s => {
    if (!hasShift) return true;
    const sh = dayShifts.find(x => x.staff_id === s.id && x.kind === "work" && x.start_time && x.end_time);
    if (!sh) return false;
    if (tlM < toMin(sh.start_time) || teM > toMin(sh.end_time)) return false;
    if (lastOff !== null && tlM > toMin(sh.end_time) - lastOff) return false;
    if (sh.break_start && sh.break_end && tlM < toMin(sh.break_end) && teM > toMin(sh.break_start)) return false;
    return true;
  });
  const free = onShift.filter(s => !bs.some(b => b.staff_id === s.id && (liveB(b) || (b.status === "block" && b.block_kind !== "idle")) && over(b, t, t + blk * 60000)))
    .map(s => ({ id: s.id, n: bs.filter(b => b.staff_id === s.id && liveB(b) && T(b.start_at) >= dayStart && T(b.start_at) < dayEnd).length }))
    .sort((a, b) => a.n - b.n || a.id.localeCompare(b.id)).map(x => x.id);
  const unassigned = bs.filter(b => !b.staff_id && liveB(b) && over(b, t, t + blk * 60000)).length;
  let left = free.length - unassigned;
  const rooms = c.store.room_count;
  if (rooms !== null && rooms !== undefined) left = Math.min(left, rooms - bs.filter(b => liveB(b) && over(b, t, t + blk * 60000)).length);
  return { free, left: Math.max(0, left), onShift: onShift.length };
}
/** 受付枠に×（受付停止）が重なっているか。1名様枠の×＝全部止める、ペア枠の×＝ペアだけ止める */
export function laneClosed(c: Pick<HeadsCtx, "lanes"|"bookings">, t: number, dur: number, people: number) {
  const { first, pair } = laneIds(c.lanes);
  const T = (iso: string) => new Date(iso).getTime();
  return c.bookings.some(b => b.status === "block" && b.block_kind === "close" && b.lane_id && (b.lane_id === first || (people >= 2 && b.lane_id === pair)) && T(b.start_at) < t + dur * 60000 && T(b.end_at) > t);
}
/** 開始時刻の候補（固定の刻みだけ。※空きの形を見て候補を間引く処理は入れない＝特許対策） */
export function gridStarts(store: Store, shifts: Shift[], date: string, dur: number) {
  const step = Math.max(5, store.start_step_min ?? 30);
  const work = shifts.filter(s => s.date === date && s.staff_id && s.kind === "work" && s.start_time && s.end_time);
  const lo = Math.min(toMin(store.open_time), ...work.map(w => toMin(w.start_time)));
  const hi = Math.max(toMin(store.close_time), ...work.map(w => toMin(w.end_time)));
  const out: number[] = [];
  for (let m = Math.ceil(lo / step) * step; m + dur <= hi; m += step) out.push(m);
  return out;
}

export interface SlotInput { store: Store; menu: Menu; coupon?: Coupon|null; lanes: Lane[]; shifts: Shift[]; bookings: Booking[]; staff: Staff[]; date: string; staffId?: string|null; now?: Date;
  /** 選んだオプション（menus の category='option'）。時間を延ばす */ options?: Menu[];
  /** 店の画面（電話予約）から：ネット掲載・受付曜日・リードタイムなどのネット用の条件を見ない */ staffMode?: boolean; excludeIds?: string[] }
/** 1日分の空き（開始時刻・割り当てる担当・残り人数） */
export function webSlots(i: SlotInput): { start: Date; staffIds: string[]; left: number }[] {
  const { store, menu: m, coupon: cp, date } = i;
  const now = i.now || new Date(); const today = ymdLocal(now);
  if (!i.staffMode) {
    const horizon = new Date(`${today}T00:00:00`); horizon.setDate(horizon.getDate() + (store.booking_horizon_days ?? 60));
    if (date < today || date > ymdLocal(horizon)) return [];
    if (!m.active || m.web_visible === false || m.category !== "technical" || !publishedNow(m.publish_from, m.publish_to, today)) return [];
    const wd = new Date(`${date}T00:00:00`).getDay();
    if (m.weekdays?.length && !m.weekdays.includes(wd)) return [];
    if (cp && (!cp.active || (cp.weekdays?.length && !cp.weekdays.includes(wd)))) return [];
    if (!webBookableWith(m, cp)) return [];
    if (i.staffId && m.nominatable === false) return [];
    // 指名は「在籍・台帳に表示・ネット指名可」の人だけ
    if (i.staffId) { const ns = i.staff.find(s => s.id === i.staffId); if (!ns || !canServe(ns) || ns.web_nominatable === false) return []; }
  }
  const people = menuPeople(m, i.lanes);
  const optMin = (i.options || []).reduce((a, x) => a + (x.duration_min || 0), 0);
  const dur = m.duration_min + optMin, blk = dur + (m.interval_min || 0);
  const lead = i.staffMode ? -Infinity : now.getTime() + (store.booking_lead_min ?? 60) * 60000;
  const ctx: HeadsCtx = { store, lanes: i.lanes, shifts: i.shifts, bookings: i.bookings, staff: i.staff, date, excludeIds: i.excludeIds };
  const idleLaneId = menuLane(i.lanes, m.lane_id)?.lane.id ?? null;
  const out: { start: Date; staffIds: string[]; left: number }[] = [];
  for (const min of gridStarts(store, i.shifts, date, dur)) {
    const t = new Date(`${date}T${pad(Math.floor(min / 60))}:${pad(min % 60)}:00`).getTime();
    if (t < lead) continue;
    const tH = hmLocal(new Date(t));
    if (!i.staffMode) {
      if (m.time_from && tH < m.time_from.slice(0, 5)) continue;
      if (m.time_to && tH > m.time_to.slice(0, 5)) continue;
      if (cp && ((cp.time_from && tH < cp.time_from.slice(0, 5)) || (cp.time_to && tH > cp.time_to.slice(0, 5)))) continue;
    }
    if (laneClosed(ctx, t, dur, people)) continue;
    const h = headsAt(ctx, t, dur, blk, { lastOrder: true, idleLaneId });
    if (h.left < people) continue;
    let ids = h.free;
    if (i.staffId) { if (!ids.includes(i.staffId)) continue; ids = [i.staffId, ...ids.filter(x => x !== i.staffId)]; }
    out.push({ start: new Date(t), staffIds: ids.slice(0, people), left: h.left });
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
  menu_coupon_only: { ja: "このメニューはクーポンからご予約ください（単品ではご予約いただけません）。", en: "This menu can only be booked with a coupon." },
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
  option_required: { ja: "必須のオプションを選んでください。", en: "Please choose the required option." },
  option_single: { ja: "このオプションは1つだけ選べます。", en: "Please choose only one option in this group." },
  option_invalid: { ja: "選んだオプションは今は選べません。もう一度選び直してください。", en: "The selected option is not available. Please choose again." },
};
export function errorText(e: unknown, lang: "ja"|"en") {
  const msg = (e as Error)?.message || String(e);
  const code = Object.keys(ERROR_TEXT).find(k => msg.includes(k));
  return code ? ERROR_TEXT[code][lang] : (lang === "en" ? "Something went wrong. Please try again." : "うまくいきませんでした。もう一度お試しください。") + (msg ? `（${msg.slice(0, 80)}）` : "");
}
