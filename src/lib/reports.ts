// 集計（サロンアンサー参考）の計算。画面に依存しない純粋な関数だけ。
// 材料は Repo.reportBundle でまとめて取ったもの（複数店舗可）。
import type { Booking, Menu, ReportBundle, Sale, Shift, ID } from "@/lib/db/types";
import { addDays, breakMin, localDate, minOfIso, toMin, ymd } from "@/lib/schedule";
import { bookingValue } from "@/lib/web";

export type Period = { from: string; to: string };   // to は含まない
export const inP = (d: string, p: Period) => d >= p.from && d < p.to;
const saleDay = (s: Sale) => localDate(s.sold_at);

/** 売上の数え方：
 *  - 金額は「確定・赤伝済みの元伝票・赤伝」をすべて足す（元伝票＋赤伝＝0 になる）
 *  - 客数などの件数は「確定」だけ（赤伝で取り消した伝票は数えない） */
export const isLive = (s: Sale) => s.status === "confirmed";
const techAmt = (s: Sale) => s.lines.filter(l => l.kind !== "product").reduce((a, l) => a + l.amount, 0) - s.discount;
const prodAmt = (s: Sale) => s.lines.filter(l => l.kind === "product").reduce((a, l) => a + l.amount, 0);
const realBooking = (b: Booking) => b.status !== "block" && b.status !== "cancelled" && b.status !== "noshow";

export interface Ctx {
  b: ReportBundle;
  bookingById: Map<ID, Booking>;
  menuById: Map<ID, Menu>;
  /** 店舗ID|お客様ID → 確定伝票の日付（昇順） */
  visits: Map<string, string[]>;
  today: string;
  nextDays: number;
  bookingsByCust: Map<string, Booking[]>;
  nextCache: Map<ID, boolean>;
}
export function makeCtx(b: ReportBundle, today: string, nextDays: number): Ctx {
  const visits = new Map<string, string[]>();
  for (const s of b.sales) if (isLive(s) && s.customer_id) { const k = `${s.store_id}|${s.customer_id}`; const a = visits.get(k) || []; a.push(saleDay(s)); visits.set(k, a); }
  for (const a of visits.values()) a.sort();
  const bookingsByCust = new Map<string, Booking[]>();
  for (const x of b.bookings) if (x.customer_id && x.status !== "block") { const k = `${x.store_id}|${x.customer_id}`; const a = bookingsByCust.get(k) || []; a.push(x); bookingsByCust.set(k, a); }
  return { b, bookingById: new Map(b.bookings.map(x => [x.id, x])), menuById: new Map(b.menus.map(m => [m.id, m])), visits, today, nextDays, bookingsByCust, nextCache: new Map() };
}

/** 新規＝その店舗での初来店（全期間）がこの期間の人 */
export function isNewCustomer(ctx: Ctx, storeId: ID, cid: ID, p: Period) {
  const f = ctx.b.firstVisits[storeId]?.[cid];
  return !!f && inP(localDate(f), p);
}

/** 施術時間（分）：予約があれば予約の長さ、無ければメニューの所要時間 */
export function treatMin(ctx: Ctx, s: Sale) {
  const bk = s.booking_id ? ctx.bookingById.get(s.booking_id) : undefined;
  if (bk) return Math.max(0, (new Date(bk.end_at).getTime() - new Date(bk.start_at).getTime()) / 60000);
  return s.lines.reduce((a, l) => a + (l.menu_id ? (ctx.menuById.get(l.menu_id)?.duration_min || 0) * Math.max(0, l.qty) : 0), 0);
}

/** 次回予約あり：会計した日〜○日後までに、そのお客様の次の予約（会計より後の日時）が台帳に入った */
export function hasNextBooking(ctx: Ctx, s: Sale) {
  if (!s.customer_id) return false;
  const c = ctx.nextCache.get(s.id); if (c !== undefined) return c;
  const bk = s.booking_id ? ctx.bookingById.get(s.booking_id) : undefined;
  const visitStart = bk ? new Date(bk.start_at).getTime() : new Date(s.sold_at).getTime() - 3 * 3600000;
  const limit = new Date(`${addDays(saleDay(s), ctx.nextDays + 1)}T00:00:00`).getTime();
  const r = (ctx.bookingsByCust.get(`${s.store_id}|${s.customer_id}`) || []).some(x => x.id !== s.booking_id
    && x.start_at > s.sold_at && new Date(x.created_at).getTime() >= visitStart && new Date(x.created_at).getTime() < limit);
  ctx.nextCache.set(s.id, r); return r;
}

/** 再来率：期間内の（最初の）来店から N 日以内にもう一度来店した割合。来店から N 日たっていない人は分母に入れない */
function returnRate(ctx: Ctx, keys: { store: ID; cid: ID; first: string }[], n: number) {
  let den = 0, num = 0;
  for (const k of keys) {
    if (addDays(k.first, n) > ctx.today) continue;
    den++;
    const v = ctx.visits.get(`${k.store}|${k.cid}`) || [];
    if (v.some(d => d > k.first && d <= addDays(k.first, n))) num++;
  }
  return { rate: den ? num / den : null, num, den };
}

export interface Kpi {
  total: number; tech: number; product: number; discount: number; reversalAmt: number; reversalCnt: number;
  guests: number; newGuests: number; repeatGuests: number; unregistered: number;
  unit: number | null; techUnit: number | null; productUnit: number | null; productBuyRate: number | null;
  treatMin: number; hourly: number | null;
  workMin: number; bookedMin: number; occupancy: number | null; staffCount: number; perStaff: number | null;
  nextRate: number | null; nextNum: number; nextDen: number;
  nominatedRate: number | null; cancelRate: number | null; noshowRate: number | null; bookingCnt: number;
  ret: Record<30 | 60 | 90, { rate: number | null; num: number; den: number }>;
  retAll: Record<30 | 60 | 90, { rate: number | null; num: number; den: number }>;
  futureBooked: number;
}

/** 担当ごとの売上の割合（明細の担当で按分。ペアは1組の料金を2人に半分ずつの行にしてある）。
 *  明細に担当が無い行は主担当の分。金額が0の伝票は主担当に全部 */
export function staffShare(s: Sale, sid: ID) {
  const who = (l: Sale["lines"][number]) => l.staff_id || s.main_staff_id || null;
  const tot = s.lines.reduce((a, l) => a + Math.abs(l.amount), 0);
  if (!tot) return s.main_staff_id === sid ? 1 : 0;
  return s.lines.filter(l => who(l) === sid).reduce((a, l) => a + Math.abs(l.amount), 0) / tot;
}
/** 売上が入る担当（明細担当。明細に担当が無い古い行だけ主担当。主担当が受付枠・フリーの伝票は明細担当だけ） */
export function saleStaffIds(s: Sale) {
  const out = new Set<ID>();
  for (const l of s.lines) { const w = l.staff_id || s.main_staff_id; if (w) out.add(w); }
  if (!s.lines.length && s.main_staff_id) out.add(s.main_staff_id);
  return [...out];
}

export interface Scope {
  sale?: (s: Sale) => boolean;
  /** 売上の按分（担当別：ペアは半分ずつ）。無い＝1 */
  weight?: (s: Sale) => number;
  booking?: ((b: Booking) => boolean) | null;   // null＝この軸では予約系の指標を出さない
  shift?: ((s: Shift) => boolean) | null;       // null＝稼働率を出さない
}

/** 出勤時間・予約時間（スタッフ×日のシフトの中に入っている予約の分だけ） */
export function workAndBooked(shifts: Shift[], bookings: Booking[], p: Period) {
  let workMin = 0, bookedMin = 0;
  const staffSet = new Set<ID>();
  const byKey = new Map<string, Booking[]>();
  for (const b of bookings) if (realBooking(b) && b.staff_id) { const k = `${b.store_id}|${b.staff_id}|${localDate(b.start_at)}`; const a = byKey.get(k) || []; a.push(b); byKey.set(k, a); }
  for (const w of shifts) {
    if (w.kind !== "work" || !w.start_time || !w.end_time || !w.staff_id || !inP(w.date, p)) continue;
    const s = toMin(w.start_time), e = toMin(w.end_time);
    workMin += Math.max(0, e - s) - breakMin(w);
    staffSet.add(w.staff_id);
    for (const b of byKey.get(`${w.store_id}|${w.staff_id}|${w.date}`) || []) {
      const a = Math.max(s, minOfIso(b.start_at)), z = Math.min(e, minOfIso(b.end_at));
      if (z > a) bookedMin += z - a;
    }
  }
  return { workMin, bookedMin, staffCount: staffSet.size };
}

export function computeKpi(ctx: Ctx, p: Period, scope: Scope = {}): Kpi {
  const { b } = ctx;
  const sales = b.sales.filter(s => inP(saleDay(s), p) && (!scope.sale || scope.sale(s)));
  const live = sales.filter(isLive);
  const w = scope.weight || (() => 1);
  const total = Math.round(sales.reduce((a, s) => a + s.total * w(s), 0));
  const tech = Math.round(sales.reduce((a, s) => a + techAmt(s) * w(s), 0));
  const product = Math.round(sales.reduce((a, s) => a + prodAmt(s) * w(s), 0));
  const discount = Math.round(sales.reduce((a, s) => a + s.discount * w(s), 0));
  const rev = sales.filter(s => s.status === "reversal");
  // 客
  const seen = new Set<string>(); const newKeys: { store: ID; cid: ID; first: string }[] = []; const allKeys: typeof newKeys = [];
  let newGuests = 0, unregistered = 0;
  for (const s of [...live].sort((x, y) => x.sold_at.localeCompare(y.sold_at))) {
    if (!s.customer_id) { unregistered++; continue; }
    const k = `${s.store_id}|${s.customer_id}`; if (seen.has(k)) continue; seen.add(k);
    const key = { store: s.store_id, cid: s.customer_id, first: saleDay(s) };
    allKeys.push(key);
    if (isNewCustomer(ctx, s.store_id, s.customer_id, p)) { newGuests++; newKeys.push(key); }
  }
  const guests = live.length;
  const techCnt = live.filter(s => s.lines.some(l => l.kind !== "product")).length;
  const prodCnt = live.filter(s => s.lines.some(l => l.kind === "product")).length;
  const tm = live.reduce((a, s) => a + treatMin(ctx, s), 0);
  // 生産性
  const wb = scope.shift === null ? { workMin: 0, bookedMin: 0, staffCount: 0 }
    : workAndBooked(b.shifts.filter(s => !scope.shift || scope.shift(s)), b.bookings.filter(x => !scope.booking || scope.booking(x)), p);
  const staffCount = wb.staffCount || (scope.shift === null ? 0 : new Set(live.flatMap(saleStaffIds)).size);
  // 予約
  const withCust = live.filter(s => s.customer_id);
  const nextNum = withCust.filter(s => hasNextBooking(ctx, s)).length;
  const linked = live.map(s => s.booking_id ? ctx.bookingById.get(s.booking_id) : undefined).filter(Boolean) as Booking[];
  const bks = scope.booking === null ? [] : b.bookings.filter(x => x.status !== "block" && inP(localDate(x.start_at), p) && (!scope.booking || scope.booking(x)));
  const nowIso = new Date().toISOString();
  const futureBooked = bks.filter(x => (x.status === "booked" || x.status === "arrived") && x.start_at >= nowIso)
    .reduce((a, x) => a + bookingValue(x, b.menus), 0);
  const r = (n: 30 | 60 | 90) => returnRate(ctx, newKeys, n);
  const ra = (n: 30 | 60 | 90) => returnRate(ctx, allKeys, n);
  return {
    total, tech, product, discount, reversalAmt: -Math.round(rev.reduce((a, s) => a + s.total * w(s), 0)), reversalCnt: rev.length,
    guests, newGuests, repeatGuests: seen.size - newGuests, unregistered,
    unit: guests ? total / guests : null, techUnit: techCnt ? tech / techCnt : null, productUnit: prodCnt ? product / prodCnt : null, productBuyRate: guests ? prodCnt / guests : null,
    treatMin: tm, hourly: tm ? total / (tm / 60) : null,
    workMin: wb.workMin, bookedMin: wb.bookedMin, occupancy: wb.workMin ? wb.bookedMin / wb.workMin : null, staffCount, perStaff: staffCount ? total / staffCount : null,
    nextRate: withCust.length ? nextNum / withCust.length : null, nextNum, nextDen: withCust.length,
    nominatedRate: linked.length ? linked.filter(x => x.nominated).length / linked.length : null,
    cancelRate: bks.length ? bks.filter(x => x.status === "cancelled" || x.status === "noshow").length / bks.length : null,
    noshowRate: bks.length ? bks.filter(x => x.status === "noshow").length / bks.length : null, bookingCnt: bks.length,
    ret: { 30: r(30), 60: r(60), 90: r(90) }, retAll: { 30: ra(30), 60: ra(60), 90: ra(90) },
    futureBooked,
  };
}

/** 期間の日付一覧 */
export function daysOf(p: Period) { const out: string[] = []; for (let d = p.from; d < p.to; d = addDays(d, 1)) out.push(d); return out; }

/** 着地予測：実績 ＋ 1営業日あたりの実績 × 残りの営業日。
 *  営業日＝シフトで誰かが出勤の日。残りの日のシフトが未入力なら、これまでの「営業日の割合」で見積もる */
export function projection(ctx: Ctx, p: Period, total: number, shiftFilter?: (s: Shift) => boolean) {
  const days = daysOf(p);
  if (!days.length || ctx.today < p.from || ctx.today >= p.to) return null;
  const work = new Set(ctx.b.shifts.filter(s => s.kind === "work" && (!shiftFilter || shiftFilter(s))).map(s => s.date));
  const salesDays = new Set(ctx.b.sales.filter(isLive).map(saleDay));
  const isBiz = (d: string) => work.has(d) || salesDays.has(d);
  const elapsed = days.filter(d => d <= ctx.today);
  const remain = days.filter(d => d > ctx.today);
  const elapsedBiz = elapsed.filter(isBiz).length;
  if (!elapsedBiz) return null;
  const remainKnown = remain.filter(d => ctx.b.shifts.some(s => s.date === d && (!shiftFilter || shiftFilter(s))));
  const remainUnknown = remain.length - remainKnown.length;
  const remainBiz = remainKnown.filter(d => work.has(d)).length + remainUnknown * (elapsedBiz / elapsed.length);
  const perDay = total / elapsedBiz;
  return { value: Math.round(total + perDay * remainBiz), perDay, elapsedBiz, remainBiz: Math.round(remainBiz * 10) / 10, estimated: remainUnknown > 0 };
}

/** 比較用の期間：同じ長さだけ前／前年同期。進行中の期間は「今日まで」に揃える */
export function comparePeriods(kind: "day" | "month" | "year" | "custom", p: Period, today: string) {
  const shiftY = (d: string, n: number) => { const [y, m, dd] = d.split("-").map(Number); const x = new Date(y + n, m - 1, dd); return ymd(x); };
  const shiftM = (d: string, n: number) => { const [y, m, dd] = d.split("-").map(Number); const last = new Date(y, m - 1 + n + 1, 0).getDate(); return ymd(new Date(y, m - 1 + n, Math.min(dd, last))); };
  const to = today >= p.from && today < p.to ? addDays(today, 1) : p.to;     // 進行中は今日まで
  const partial = to !== p.to;
  const len = Math.round((new Date(`${to}T00:00:00`).getTime() - new Date(`${p.from}T00:00:00`).getTime()) / 86400000);
  const out: { label: string; p: Period }[] = [];
  if (kind === "month") out.push({ label: partial ? "前月（同日まで）" : "前月", p: { from: shiftM(p.from, -1), to: partial ? shiftM(to, -1) : shiftM(p.to, -1) } });
  else if (kind === "day") out.push({ label: "前週の同じ曜日", p: { from: addDays(p.from, -7), to: addDays(p.to, -7) } });
  else if (kind === "custom") out.push({ label: "直前の同じ日数", p: { from: addDays(p.from, -len), to: p.from } });
  out.push({ label: partial ? "前年同期（同日まで）" : "前年同期", p: { from: shiftY(p.from, -1), to: shiftY(to, -1) } });
  return { current: { from: p.from, to }, partial, list: out };
}

export const pct = (x: number | null | undefined, digits = 1) => x === null || x === undefined ? "—" : `${(x * 100).toFixed(digits)}%`;
export const yenR = (x: number | null | undefined) => x === null || x === undefined ? "—" : "¥" + (Math.round(x) || 0).toLocaleString("ja-JP");
export const hours = (min: number) => `${(min / 60).toFixed(1)}h`;
export function diffRate(cur: number, prev: number) { return prev ? cur / prev - 1 : null; }
