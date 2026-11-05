"use client";
// 月間表示：各日に 予約件数・売上見込み・出勤人数・空き率。空き率でヒートマップ（空きが多いほど濃い）。
import { useEffect, useMemo, useState } from "react";
import { getRepo, yen, todayStr, type Booking, type Menu, type Shift, type Store, type Staff, type Lane } from "@/lib/db";
import { WD, addDays, addMonths, dow, monthDays, dayStats, heatColor, isoAt, localDate } from "@/lib/schedule";
import { headsAt, laneClosed, gridStarts, menuPeople } from "@/lib/web";

export default function MonthView({ date, setDate, onPickDay, menus, store, staff, lanes }: { date: string; setDate: (d: string) => void; onPickDay: (d: string) => void; menus: Menu[]; store: Store | null; staff: Staff[]; lanes: Lane[] }) {
  const repo = getRepo();
  const ym = date.slice(0, 7);
  const days = useMemo(() => monthDays(ym), [ym]);
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [shifts, setShifts] = useState<Shift[]>([]);
  useEffect(() => { let on = true; (async () => {
    const to = addDays(days[days.length - 1], 1);
    const [b, s] = await Promise.all([repo.bookingsBetween(days[0], to), repo.shiftsBetween(days[0], to)]);
    if (on) { setBookings(b); setShifts(s); }
  })(); return () => { on = false; }; }, [repo, days]);

  const stats = days.map(d => dayStats(d, shifts, bookings, menus));
  // 受けられる開始時刻の数（人数×部屋）：一番短い1名メニュー／ペアメニューで数える
  const one = menus.filter(m => m.category === "technical" && menuPeople(m, lanes) === 1 && m.duration_min > 0).sort((a, b) => a.duration_min - b.duration_min)[0];
  const pairM = menus.filter(m => m.category === "technical" && menuPeople(m, lanes) >= 2).sort((a, b) => a.duration_min - b.duration_min)[0];
  const today0 = todayStr();
  const openings = (d: string) => {
    if (!store || d < today0) return null;
    const dayB = bookings.filter(b => localDate(b.start_at) === d && b.status !== "cancelled");
    const ctx = { store, lanes, shifts, bookings: dayB, staff, date: d };
    const count = (m: Menu | undefined, need: number) => { if (!m) return null; const dur = m.duration_min, blk = dur + (m.interval_min || 0); return gridStarts(store, shifts, d, dur).filter(min => { const t = new Date(isoAt(d, min)).getTime(); return !laneClosed(ctx, t, dur, need) && headsAt(ctx, t, dur, blk, { lastOrder: true }).left >= need; }).length; };
    return { one: count(one, 1), pair: count(pairM, 2) };
  };
  const lead = dow(days[0]);
  const cells: (typeof stats[number] | null)[] = [...Array(lead).fill(null), ...stats];
  while (cells.length % 7) cells.push(null);
  const today = todayStr();
  const sumCount = stats.reduce((a, s) => a + s.count, 0), sumSales = stats.reduce((a, s) => a + s.sales, 0);
  const work = stats.reduce((a, s) => a + s.workMin, 0), free = stats.reduce((a, s) => a + s.freeMin, 0);
  const missing = stats.filter(s => s.noShift).length;

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 mb-2">
        <div className="text-lg font-bold tabular-nums">{ym.replace("-", "年")}月</div>
        <div className="flex gap-1">
          <button className="btn" onClick={() => setDate(`${addMonths(ym, -1)}-01`)}>前月</button>
          <button className="btn" onClick={() => setDate(today)}>今月</button>
          <button className="btn" onClick={() => setDate(`${addMonths(ym, 1)}-01`)}>次月</button>
        </div>
        <div className="text-sm text-stone-600">予約 {sumCount}件／売上見込み {yen(sumSales)}／空き率 {work ? Math.round(100 * free / work) : "—"}%</div>
        {missing > 0 && <span className="text-xs text-amber-700 bg-amber-100 rounded px-2 py-0.5">！シフト未入力 {missing}日</span>}
        <div className="ml-auto flex items-center gap-1 text-[11px] text-stone-600">
          空き 少
          <span className="inline-block w-24 h-3 rounded" style={{ background: `linear-gradient(90deg, ${heatColor(0)}, ${heatColor(0.5)}, ${heatColor(1)})` }} />
          多
          <span className="inline-block w-3 h-3 rounded-sm bg-stone-300 ml-2" />店休
        </div>
      </div>
      <div className="grid grid-cols-7 border-l border-t rounded overflow-hidden bg-white">
        {WD.map((w, i) => <div key={w} className={`text-center text-xs font-semibold py-1 border-r border-b bg-stone-100 ${i === 0 ? "text-rose-600" : i === 6 ? "text-sky-700" : ""}`}>{w}</div>)}
        {cells.map((s, i) => {
          if (!s) return <div key={i} className="border-r border-b bg-stone-50 min-h-[84px]" />;
          const w = dow(s.date);
          const dark = !s.closed && s.freeRate !== null && s.freeRate > 0.55;
          return (
            <button key={s.date} onClick={() => onPickDay(s.date)} title="押すと日表示"
              className={`relative text-left border-r border-b p-1 min-h-[84px] hover:ring-2 hover:ring-amber-400 hover:z-10 ${s.closed ? "bg-stone-300 text-stone-600" : ""} ${dark ? "text-white" : ""}`}
              style={!s.closed ? { background: heatColor(s.freeRate) } : undefined}>
              <div className="flex items-center gap-1">
                <span className={`text-sm font-bold ${s.date === today ? "bg-amber-400 text-stone-900 rounded-full px-1.5" : (!dark && w === 0) ? "text-rose-600" : (!dark && w === 6) ? "text-sky-700" : ""}`}>{Number(s.date.slice(8))}</span>
                {s.noShift && !s.closed && <span className="text-[10px] font-bold text-white bg-amber-500 rounded px-1" title="シフト未入力">！</span>}
              </div>
              {s.closed ? <div className="text-xs mt-1">店休</div> : (
                <div className="text-[10px] sm:text-[11px] leading-snug mt-0.5 tabular-nums">
                  <div>予約 <b>{s.count}</b>件</div>
                  <div>{yen(s.sales)}</div>
                  <div>出勤 {s.staffCount}人</div>
                  <div>空き <b>{s.freeRate === null ? "—" : `${Math.round(s.freeRate * 100)}%`}</b></div>
                  {(() => { const o = openings(s.date); return o && (o.one !== null || o.pair !== null) ? <div className="text-[10px]" title="受けられる開始時刻の数（人数×部屋）">受付 1名{o.one ?? "—"}{o.pair !== null ? `・ペア${o.pair}` : ""}</div> : null; })()}
                </div>
              )}
            </button>
          );
        })}
      </div>
      <div className="text-[11px] text-stone-500 mt-1">売上見込み＝その日の予約メニュー価格の合計（ペアは1組の料金）。受付＝今日以降、一番短い1名メニュー／ペアメニューを受けられる開始時刻の数（出勤中で空いている人数×空き部屋で計算）。空き率＝（出勤時間−予約時間）÷出勤時間。シフトが入っていない日は空き率が出ません。</div>
    </div>
  );
}
