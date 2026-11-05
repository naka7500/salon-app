"use client";
// 週間表示：横＝日（日〜土）、各日の中にスタッフ別の細い縦帯、縦＝時間（15分刻み）。
// 画面が狭い（900px未満）ときは3日表示。
import { useEffect, useMemo, useState } from "react";
import { getRepo, hm, AUTO_IDLE_NOTE, type Booking, type Staff, type Menu, type Customer, type Store, type Lane, type Shift } from "@/lib/db";
import { WD, addDays, dow, toMin, minOfIso, localDate, dayStats, fmtMin, isRealBooking, pickLanes } from "@/lib/schedule";

const ROW = 12;      // 15分の高さ(px)
const TIME_W = 38;   // 左の時刻ラベル幅
const LANE_W = 7;    // 受付枠の細帯の幅

const BLOCK_BG: Record<string, string> = { break: "#2e7d32", guarantee: "#e91e63", close: "#8b1e1e" };
const STRIPE = "repeating-linear-gradient(135deg, rgba(139,30,30,.55) 0 3px, transparent 3px 7px)";

function useNarrow(px = 900) {
  const [n, setN] = useState(false);
  useEffect(() => { const q = window.matchMedia(`(max-width: ${px - 1}px)`); const f = () => setN(q.matches); f(); q.addEventListener("change", f); return () => q.removeEventListener("change", f); }, [px]);
  return n;
}

export default function WeekView({ date, setDate, onPickDay, store, staff: visible, allStaff = [], lanes, menus, customers }: {
  date: string; setDate: (d: string) => void; onPickDay: (d: string) => void;
  store: Store | null; staff: Staff[]; allStaff?: Staff[]; lanes: Lane[]; menus: Menu[]; customers: Customer[];
}) {
  const repo = getRepo();
  const narrow = useNarrow();
  const span = narrow ? 3 : 7;
  const start = narrow ? date : addDays(date, -dow(date));
  const days = useMemo(() => Array.from({ length: span }, (_, i) => addDays(start, i)), [start, span]);
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [shifts, setShifts] = useState<Shift[]>([]);
  useEffect(() => { let on = true; (async () => {
    const [b, s] = await Promise.all([repo.bookingsBetween(days[0], addDays(days[days.length - 1], 1)), repo.shiftsBetween(days[0], addDays(days[days.length - 1], 1))]);
    if (on) { setBookings(b); setShifts(s); }
  })(); return () => { on = false; }; }, [repo, days]);

  // 退職・台帳非表示の人でも、この期間に予約が残っていれば列を出す
  const staff = [...visible, ...allStaff.filter(s => !visible.some(x => x.id === s.id) && bookings.some(b => b.staff_id === s.id && b.status !== "cancelled"))];
  const open = store ? toMin(store.open_time) : 600, close = store ? toMin(store.close_time) : 1140;
  const workS = shifts.filter(s => s.kind === "work" && s.start_time);
  const axisStart = Math.floor(Math.min(open, ...workS.map(s => toMin(s.start_time))) / 60) * 60;
  const axisEnd = Math.ceil(Math.max(close, ...workS.map(s => toMin(s.end_time))) / 60) * 60;
  const H = ((axisEnd - axisStart) / 15) * ROW;
  const y = (m: number) => ((Math.min(axisEnd, Math.max(axisStart, m)) - axisStart) / 15) * ROW;
  const hours: number[] = []; for (let m = axisStart; m <= axisEnd; m += 60) hours.push(m);
  const { single, pair } = pickLanes(lanes);
  const laneList = [single, pair].filter(Boolean) as Lane[];
  const today = new Date(); const todayS = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;

  const custName = (b: Booking) => b.customer_name || customers.find(c => c.id === b.customer_id)?.name || "";
  const menuOf = (b: Booking) => menus.find(m => m.id === b.menu_ids[0]);
  const step = narrow ? 3 : 7;
  const label = `${days[0].slice(5).replace("-", "/")}〜${days[days.length - 1].slice(5).replace("-", "/")}`;

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 mb-2">
        <div className="text-lg font-bold tabular-nums">{days[0].slice(0, 4)}年 {label}</div>
        <div className="flex gap-1">
          <button className="btn" onClick={() => setDate(addDays(date, -step))}>{narrow ? "前の3日" : "前週"}</button>
          <button className="btn" onClick={() => setDate(todayS)}>{narrow ? "今日" : "今週"}</button>
          <button className="btn" onClick={() => setDate(addDays(date, step))}>{narrow ? "次の3日" : "次週"}</button>
        </div>
        <div className="ml-auto flex flex-wrap gap-2 text-[11px] text-stone-600 items-center">
          <span className="inline-flex items-center gap-1"><span className="inline-block w-3 h-3 rounded-sm bg-sky-100 border border-sky-300" />受付中（IDLE）</span>
          <span className="inline-flex items-center gap-1"><span className="inline-block w-3 h-3 rounded-sm border border-rose-300" style={{ background: STRIPE }} />×受付停止</span>
          <span className="inline-flex items-center gap-1"><span className="inline-block w-3 h-3 rounded-sm bg-stone-200" />出勤外</span>
          <span>日付を押すと日表示</span>
        </div>
      </div>

      <div className="overflow-auto border rounded bg-white" style={{ maxHeight: "78vh" }}>
        <div className="flex min-w-full">
          {/* 時刻ラベル */}
          <div className="shrink-0 sticky left-0 z-20 bg-white border-r" style={{ width: TIME_W }}>
            <div className="sticky top-0 bg-stone-100 border-b" style={{ height: 64 }} />
            <div className="relative" style={{ height: H }}>
              {hours.map(m => <div key={m} className="absolute right-1 text-[10px] text-stone-500 -translate-y-1/2" style={{ top: y(m) }}>{fmtMin(m)}</div>)}
            </div>
          </div>
          {days.map(d => {
            const st = dayStats(d, shifts, bookings, menus);
            const dayB = bookings.filter(b => localDate(b.start_at) === d && b.status !== "cancelled");
            const w = dow(d);
            const shiftOf = (sid: string) => shifts.find(s => s.date === d && s.staff_id === sid);
            const laneBlocks = (l: Lane) => dayB.filter(b => b.status === "block" && b.lane_id === l.id);
            const singleIdle = single ? laneBlocks(single).filter(b => b.block_kind === "idle") : [];
            return (
              <div key={d} className={`flex-1 border-r last:border-r-0 ${d === todayS ? "bg-amber-50/40" : ""}`} style={{ minWidth: narrow ? 110 : 130 }}>
                {/* 日のヘッダー */}
                <button onClick={() => onPickDay(d)} className={`sticky top-0 z-10 w-full text-left px-1.5 py-1 border-b hover:bg-amber-100 ${d === todayS ? "bg-amber-100" : st.closed ? "bg-stone-200" : "bg-stone-100"}`} style={{ height: 64 }}>
                  <div className={`text-sm font-bold ${w === 0 ? "text-rose-600" : w === 6 ? "text-sky-700" : ""}`}>{Number(d.slice(8))}日（{WD[w]}）{st.noShift && !st.closed && <span className="ml-1 text-[10px] text-white bg-amber-500 rounded px-1" title="シフト未入力">！</span>}</div>
                  {st.closed ? <div className="text-[11px] text-stone-600">店休日</div> : <>
                    <div className="text-[10px] text-stone-600 leading-tight">予約{st.count}件／出勤{st.staffCount}人</div>
                    <div className="text-[10px] leading-tight"><span className="text-stone-600">空き</span> <b className="text-cyan-800">{st.noShift ? "—" : `${(st.freeMin / 60).toFixed(1)}h`}</b></div>
                  </>}
                  <div className="flex text-[9px] text-stone-500 mt-0.5" style={{ paddingLeft: laneList.length * LANE_W }}>
                    {staff.map(s => <div key={s.id} className={`flex-1 text-center truncate ${visible.some(x => x.id === s.id) ? "" : "line-through opacity-60"}`} title={s.name} style={s.color ? { borderBottom: `2px solid ${s.color}` } : undefined}>{s.name.slice(0, 2)}</div>)}
                  </div>
                </button>
                {/* 本体 */}
                <div className="relative flex" style={{ height: H }}>
                  {/* 1名様枠IDLE＝日全体に薄い背景 */}
                  {singleIdle.map(b => <div key={b.id} className="absolute left-0 right-0 bg-sky-100/70" style={{ top: y(minOfIso(b.start_at)), height: y(minOfIso(b.end_at)) - y(minOfIso(b.start_at)) }} />)}
                  {hours.map(m => <div key={m} className="absolute left-0 right-0 border-t border-stone-200" style={{ top: y(m) }} />)}
                  {/* 受付枠の細帯（1名様／ペア） */}
                  {laneList.map(l => (
                    <div key={l.id} className="relative shrink-0 border-r border-stone-200" style={{ width: LANE_W }} title={l.name}>
                      {laneBlocks(l).map(b => <div key={b.id} className="absolute left-0 right-0" title={`${l.name} ${b.block_kind === "idle" ? "IDLE" : "×"} ${hm(b.start_at)}–${hm(b.end_at)}${b.note === AUTO_IDLE_NOTE ? "（シフトから自動）" : ""}`}
                        style={{ top: y(minOfIso(b.start_at)), height: y(minOfIso(b.end_at)) - y(minOfIso(b.start_at)), background: b.block_kind === "idle" ? "#7dd3fc" : STRIPE }} />)}
                    </div>
                  ))}
                  {/* スタッフの縦帯 */}
                  {staff.map(s => {
                    const sh = shiftOf(s.id);
                    const items = dayB.filter(b => b.staff_id === s.id);
                    const ws = sh && sh.kind === "work" && sh.start_time ? toMin(sh.start_time) : null, we = sh && sh.kind === "work" ? toMin(sh.end_time) : null;
                    return (
                      <div key={s.id} className="relative flex-1 border-r border-stone-100 last:border-r-0">
                        {sh && (ws === null ? <div className="absolute inset-0 bg-stone-200/80" /> : <>
                          <div className="absolute left-0 right-0 top-0 bg-stone-200/80" style={{ height: y(ws) }} />
                          <div className="absolute left-0 right-0 bottom-0 bg-stone-200/80" style={{ top: y(we!) }} />
                        </>)}
                        {items.map(b => {
                          const top = y(minOfIso(b.start_at)), h = Math.max(ROW, y(minOfIso(b.end_at)) - top);
                          if (b.status === "block") {
                            const k = b.block_kind || "close";
                            return <div key={b.id} className="absolute left-px right-px rounded-sm" title={`${k === "break" ? "BREAK" : k === "guarantee" ? "保証" : "×"} ${hm(b.start_at)}–${hm(b.end_at)}`}
                              style={{ top, height: h, background: k === "close" ? STRIPE : BLOCK_BG[k], opacity: k === "close" ? 1 : 0.85 }} />;
                          }
                          const m = menuOf(b);
                          return (
                            <button key={b.id} onClick={() => onPickDay(d)} className={`absolute left-px right-px rounded-sm overflow-hidden text-left text-[9px] leading-tight text-white px-0.5 shadow-sm ${isRealBooking(b) ? "" : "opacity-50"} ${b.status === "done" ? "opacity-70" : ""}`}
                              style={{ top, height: h, background: m?.color || "#777" }} title={`${hm(b.start_at)}–${hm(b.end_at)} ${custName(b)} ${m?.name || ""}`}>
                              <div className="font-semibold truncate">{custName(b).split(" ")[0]}</div>
                              {h > 30 && <div className="truncate opacity-90">{m?.short_name || m?.name}</div>}
                            </button>
                          );
                        })}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
