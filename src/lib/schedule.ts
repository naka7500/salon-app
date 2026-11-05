// 週・月表示とシフトで共通に使う計算（画面に依存しない）
import { AUTO_IDLE_NOTE, type Booking, type Lane, type Menu, type Repo, type Shift, type ShiftKind } from "@/lib/db/types";

export const WD = ["日", "月", "火", "水", "木", "金", "土"];
export const KIND_LABEL: Record<ShiftKind, string> = { work: "出勤", off: "休み", paid: "有給", closed: "店休" };

export function ymd(x: Date) { return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`; }
export function addDays(d: string, n: number) { const x = new Date(`${d}T00:00:00`); x.setDate(x.getDate() + n); return ymd(x); }
export function dow(d: string) { return new Date(`${d}T00:00:00`).getDay(); }
export function monthDays(ym: string) { const [y, m] = ym.split("-").map(Number); const n = new Date(y, m, 0).getDate(); return Array.from({ length: n }, (_, i) => `${ym}-${String(i + 1).padStart(2, "0")}`); }
export function addMonths(ym: string, n: number) { const [y, m] = ym.split("-").map(Number); const x = new Date(y, m - 1 + n, 1); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}`; }
export function toMin(t?: string | null) { if (!t) return 0; const [h, m] = t.split(":").map(Number); return h * 60 + (m || 0); }
export function minOfIso(iso: string) { const d = new Date(iso); return d.getHours() * 60 + d.getMinutes(); }
export function localDate(iso: string) { return ymd(new Date(iso)); }
export function isoAt(date: string, minute: number) { return new Date(`${date}T${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}:00`).toISOString(); }
export const fmtMin = (m: number) => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`;

/** 予約として数えるもの（ブロック・キャンセル・無断は除く） */
export const isRealBooking = (b: Booking) => b.status !== "block" && b.status !== "cancelled" && b.status !== "noshow";

export interface DayStats {
  date: string; count: number; sales: number; staffCount: number; workMin: number; bookedMin: number; freeMin: number;
  freeRate: number | null; closed: boolean; noShift: boolean;
}

/** 1日の集計：予約件数・売上見込み・出勤人数・出勤時間・予約時間・空き時間・空き率 */
export function dayStats(date: string, shifts: Shift[], bookings: Booking[], menus: Menu[]): DayStats {
  const ss = shifts.filter(s => s.date === date);
  const work = ss.filter(s => s.kind === "work" && s.start_time && s.end_time);
  const closed = ss.length > 0 && ss.every(s => s.kind === "closed" || s.is_store_closed);
  const bs = bookings.filter(b => localDate(b.start_at) === date && isRealBooking(b));
  const sales = bs.reduce((a, b) => a + b.menu_ids.reduce((x, id) => x + (menus.find(m => m.id === id)?.price || 0), 0), 0);
  let workMin = 0, bookedMin = 0;
  for (const w of work) {
    const s = toMin(w.start_time), e = toMin(w.end_time);
    workMin += Math.max(0, e - s);
    for (const b of bs.filter(b => b.staff_id === w.staff_id)) {
      const bs0 = Math.max(s, minOfIso(b.start_at)), be = Math.min(e, minOfIso(b.end_at));
      if (be > bs0) bookedMin += be - bs0;
    }
  }
  const freeMin = Math.max(0, workMin - bookedMin);
  return { date, count: bs.length, sales, staffCount: work.length, workMin, bookedMin, freeMin, freeRate: workMin ? freeMin / workMin : null, closed, noShift: ss.length === 0 };
}

/** 受付枠の並べ方：1名様枠＝sort_order が一番小さい枠、ペア枠＝capacity 2 以上の枠（1名様枠以外） */
export function pickLanes(lanes: Lane[]) {
  const sorted = [...lanes].filter(l => l.active).sort((a, b) => a.sort_order - b.sort_order);
  const single = sorted[0];
  const pair = sorted.find(l => l !== single && l.capacity >= 2);
  return { single, pair };
}

/** 15分ごとの出勤人数から、受付枠IDLEの時間帯を作る。
 *  出勤1名以上の時間 → 1名様枠IDLE、2名以上の時間 → ペア枠IDLE */
export function planAutoIdle(date: string, shifts: Shift[], lanes: Lane[]) {
  const { single, pair } = pickLanes(lanes);
  const work = shifts.filter(s => s.date === date && s.kind === "work" && s.start_time && s.end_time);
  if (!single || !work.length) return [] as { lane_id: string; from: number; to: number }[];
  const from = Math.min(...work.map(w => toMin(w.start_time))), to = Math.max(...work.map(w => toMin(w.end_time)));
  const count = (m: number) => work.filter(w => toMin(w.start_time) <= m && m < toMin(w.end_time)).length;
  const out: { lane_id: string; from: number; to: number }[] = [];
  const spans = (need: number, lane_id: string) => {
    let cur: number | null = null;
    for (let m = from; m <= to; m += 15) {
      const ok = m < to && count(m) >= need;
      if (ok && cur === null) cur = m;
      if (!ok && cur !== null) { out.push({ lane_id, from: cur, to: m }); cur = null; }
    }
  };
  spans(1, single.id);
  if (pair) spans(2, pair.id);
  return out;
}

/** 受付枠に「手で置いた」ブロックがある日か（自動生成の印が付いていないIDLE/×） */
export function hasManualLaneBlock(date: string, bookings: Booking[]) {
  return bookings.some(b => b.status === "block" && !!b.lane_id && !!b.block_kind && b.note !== AUTO_IDLE_NOTE && localDate(b.start_at) === date);
}

/** シフト確定：その月の各日に受付枠IDLEを自動で並べる。
 *  手で置いた受付枠ブロックがある日はそのまま。自動生成した分（note=auto-idle）だけ作り直す。 */
export async function confirmShiftMonth(repo: Repo, ym: string) {
  const days = monthDays(ym);
  const [shifts, bookings, lanes, store] = await Promise.all([
    repo.shiftsBetween(days[0], addDays(days[days.length - 1], 1)),
    repo.bookingsBetween(days[0], addDays(days[days.length - 1], 1)),
    repo.lanes(), repo.store(),
  ]);
  const toDelete: string[] = []; const toCreate: Omit<Booking, "id" | "created_at" | "updated_at">[] = [];
  const skipped: string[] = []; let madeDays = 0;
  for (const d of days) {
    if (hasManualLaneBlock(d, bookings)) { skipped.push(d); continue; }
    toDelete.push(...bookings.filter(b => b.note === AUTO_IDLE_NOTE && localDate(b.start_at) === d).map(b => b.id));
    const plan = planAutoIdle(d, shifts, lanes);
    if (plan.length) madeDays++;
    for (const p of plan) toCreate.push({ store_id: store.id, lane_id: p.lane_id, staff_id: null, start_at: isoAt(d, p.from), end_at: isoAt(d, p.to), status: "block", channel: "block", block_kind: "idle", menu_ids: [], nominated: false, note: AUTO_IDLE_NOTE });
  }
  if (toDelete.length) await repo.deleteBookings(toDelete);
  const made = toCreate.length ? await repo.createBookings(toCreate) : 0;
  const rec = await repo.markShiftMonth(ym);
  return { made, madeDays, skipped, confirmed_at: rec.confirmed_at };
}

/** 空き率 → ヒートマップ色（空きが多いほど濃い） */
export function heatColor(rate: number | null) {
  if (rate === null) return "transparent";
  const a = 0.08 + Math.min(1, Math.max(0, rate)) * 0.72;
  return `rgba(14, 116, 144, ${a.toFixed(2)})`;
}
