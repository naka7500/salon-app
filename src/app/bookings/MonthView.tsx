"use client";
// 月間表示：各日に 予約件数・売上見込み・出勤人数・空き率。空き率でヒートマップ（空きが多いほど濃い）。
import { useEffect, useMemo, useState } from "react";
import { getRepo, yen, todayStr, type Booking, type Menu, type Shift } from "@/lib/db";
import { WD, addDays, addMonths, dow, monthDays, dayStats, heatColor } from "@/lib/schedule";

export default function MonthView({ date, setDate, onPickDay, menus }: { date: string; setDate: (d: string) => void; onPickDay: (d: string) => void; menus: Menu[] }) {
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
                </div>
              )}
            </button>
          );
        })}
      </div>
      <div className="text-[11px] text-stone-500 mt-1">売上見込み＝その日の予約メニュー価格の合計。空き率＝（出勤時間−予約時間）÷出勤時間。シフトが入っていない日は空き率が出ません。</div>
    </div>
  );
}
