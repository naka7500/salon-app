"use client";
// 予約台帳：カミングスーン型の「横型・日表示」
//   時間が横（15分刻み）、行＝受付枠（1名様／2名様ペア）とスタッフ。
//   受付枠行に IDLE（受付中）/ ×（受付停止）を置き、スタッフ行に予約・BREAK・保証を置く。
import { useEffect, useMemo, useState, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import WeekView from "./WeekView";
import MonthView from "./MonthView";
import { getRepo, todayStr, hm, AUTO_IDLE_NOTE, CHANNEL_LABEL, CHANNEL_COLOR, STATUS_LABEL, staffLabel, type Booking, type Staff, type Menu, type Customer, type Resource, type Store, type Lane, type Channel, type BlockKind, type Shift, type AppNotification } from "@/lib/db";
import { INBOX_EVENT } from "@/components/Nav";
import { KIND_LABEL } from "@/lib/schedule";

const CELL = 26;        // 15分の幅(px)
const SUB_H = 30;       // 1段の高さ(px)
const LABEL_W = 150;    // 左の行ラベル幅
const PRE_OPEN = 60;    // 開店前に表示する分数（CSは9:00から表示）

const BLOCK: Record<BlockKind, { label: string; short: string; bg: string; fg: string }> = {
  idle:      { label: "IDLE（受付中）", short: "IDL", bg: "#6b6b6b", fg: "#fff" },
  break:     { label: "BREAK（休憩）",  short: "BRK", bg: "#2e7d32", fg: "#fff" },
  close:     { label: "×（受付停止）",  short: "×",   bg: "#8b1e1e", fg: "#fff" },
  guarantee: { label: "保証（お直し）", short: "保証", bg: "#e91e63", fg: "#fff" },
};
const WD = ["日","月","火","水","木","金","土"];

function minutesOf(t: string) { const [h, m] = t.split(":").map(Number); return h * 60 + m; }
function addDays(d: string, n: number) { const x = new Date(`${d}T00:00:00`); x.setDate(x.getDate() + n); return ymd(x); }
function ymd(x: Date) { return `${x.getFullYear()}-${String(x.getMonth()+1).padStart(2,'0')}-${String(x.getDate()).padStart(2,'0')}`; }
function minOfIso(iso: string) { const d = new Date(iso); return d.getHours() * 60 + d.getMinutes(); }
function isoAt(date: string, minute: number) { return new Date(`${date}T${String(Math.floor(minute/60)).padStart(2,'0')}:${String(minute%60).padStart(2,'0')}:00`).toISOString(); }
const fmtMin = (m: number) => `${Math.floor(m/60)}:${String(m%60).padStart(2,'0')}`;

/** 重なるものを段に振り分ける（最低2段） */
function layoutRows<T extends { start_at: string; end_at: string }>(items: T[], minRows = 2) {
  const ends: number[] = []; const out: { item: T; row: number }[] = [];
  for (const it of [...items].sort((a, b) => a.start_at.localeCompare(b.start_at))) {
    const s = new Date(it.start_at).getTime(), e = new Date(it.end_at).getTime();
    let r = ends.findIndex(x => x <= s); if (r < 0) { r = ends.length; ends.push(0); }
    ends[r] = e; out.push({ item: it, row: r });
  }
  return { placed: out, rows: Math.max(minRows, ends.length) };
}

type View = 'day'|'week'|'month';
const VIEW_KEY = 'salon-app.bookings-view';
const VIEW_LABEL: Record<View, string> = { day: '日', week: '週', month: '月' };

type Sel = { kind: 'lane'|'staff'; id: string; from: number; to: number } | null;

export default function BookingsPage() {
  const repo = getRepo();
  const router = useRouter();
  const [date, setDate] = useState(todayStr());
  const [store, setStore] = useState<Store|null>(null);
  const [staff, setStaff] = useState<Staff[]>([]);
  // 会社の全スタッフ（退職・台帳非表示も）：その人の予約が残っている日だけ行を出す
  const [allStaff, setAllStaff] = useState<Staff[]>([]);
  const [lanes, setLanes] = useState<Lane[]>([]);
  const [resources, setResources] = useState<Resource[]>([]);
  const [menus, setMenus] = useState<Menu[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [editing, setEditing] = useState<Partial<Booking>|null>(null);
  const [blockEdit, setBlockEdit] = useState<Booking|null>(null);
  const [sel, setSel] = useState<Sel>(null);
  const [menuShort, setMenuShort] = useState(true);
  const [view, setViewState] = useState<View>('day');
  useEffect(() => { void Promise.resolve().then(() => { try { const v = localStorage.getItem(VIEW_KEY) as View | null; if (v && v in VIEW_LABEL) setViewState(v); } catch {} }); }, []);
  const setView = (v: View) => { setViewState(v); try { localStorage.setItem(VIEW_KEY, v); } catch {} };
  const pickDay = (d: string) => { setDate(d); setView('day'); };
  const drag = useRef<{ kind: 'lane'|'staff'; id: string; from: number } | null>(null);

  const [dayShifts, setDayShifts] = useState<Shift[]>([]);
  // 新しいネット予約（通知キューの未確認分）
  const [inbox, setInbox] = useState<AppNotification[] | null>(null);
  const [inboxOpen, setInboxOpen] = useState(false);
  const loadInbox = useCallback(async () => { try { setInbox(await repo.notifications(true)); } catch { setInbox(null); } }, [repo]);
  useEffect(() => { void Promise.resolve().then(loadInbox); }, [loadInbox]);
  async function openNotice(n: AppNotification) {
    if (!n.booking_id) return;
    const b = await repo.booking(n.booking_id); if (!b) return;
    const d = new Date(b.start_at); setDate(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`); setView('day'); setInboxOpen(false);
    await repo.markNotificationsRead([n.id]); await loadInbox(); window.dispatchEvent(new Event(INBOX_EVENT));
    setEditing(b);
  }
  async function markAllRead() { if (!inbox?.length) return; await repo.markNotificationsRead(inbox.map(x => x.id)); await loadInbox(); window.dispatchEvent(new Event(INBOX_EVENT)); setInboxOpen(false); }
  const newCount = inbox ? inbox.filter(n => n.kind === 'new_booking').length : 0;
  const cancelCount = inbox ? inbox.filter(n => n.kind === 'cancel_booking').length : 0;
  const inboxButton = inbox && inbox.length > 0 && (
    <button onClick={() => setInboxOpen(true)} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-rose-600 text-white text-sm font-bold shadow-sm hover:bg-rose-700" aria-label={`新しいネット予約 ${newCount}件`}>
      <span className="w-2 h-2 rounded-full bg-white animate-pulse" />新しいネット予約 {newCount}件{cancelCount ? `／キャンセル ${cancelCount}件` : ''}
    </button>
  );
  const inboxModal = inboxOpen && inbox && (
    <div className="fixed inset-0 bg-black/30 z-50 flex items-end sm:items-center justify-center" onClick={() => setInboxOpen(false)}>
      <div className="bg-white w-full sm:max-w-lg rounded-t-xl sm:rounded-xl p-4 max-h-[85vh] overflow-auto" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-2"><div className="font-bold">ネット予約のお知らせ（未確認 {inbox.length}件）</div><button className="btn" onClick={() => setInboxOpen(false)}>閉じる</button></div>
        <div className="space-y-2">
          {inbox.map(n => (
            <div key={n.id} className={`border rounded-lg p-2 ${n.kind === 'cancel_booking' ? 'border-stone-300 bg-stone-50' : 'border-rose-200 bg-rose-50/40'}`}>
              <div className="flex items-start gap-2">
                <div className="flex-1 min-w-0"><div className="font-semibold text-sm">{n.subject}</div><div className="text-[11px] text-stone-500">受付 {new Date(n.created_at).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}・メール：{n.status === 'queued' ? '送信待ち（未接続）' : n.status}</div></div>
                {n.booking_id && <button className="btn text-xs whitespace-nowrap" onClick={() => openNotice(n)}>台帳で開く</button>}
              </div>
              {n.body && <pre className="text-xs whitespace-pre-wrap text-stone-700 mt-1 font-sans">{n.body}</pre>}
            </div>
          ))}
        </div>
        <div className="flex justify-end mt-3"><button className="btn-primary" onClick={markAllRead}>すべて確認済みにする</button></div>
      </div>
    </div>
  );
  const reload = useCallback(async () => {
    void loadInbox();
    setBookings(await repo.bookingsOn(date));
    try { setDayShifts(await repo.shiftsBetween(date, addDays(date, 1))); } catch { setDayShifts([]); }
  }, [repo, date, loadInbox]);
  const shiftLabel = (sid: string) => { const x = dayShifts.find(s => s.staff_id === sid); if (!x) return ""; return x.kind === "work" ? `${x.start_time}–${x.end_time}${x.break_start ? `（休憩${x.break_start}–${x.break_end}）` : ""}` : KIND_LABEL[x.kind]; };
  const isOff = (sid: string) => { const x = dayShifts.find(s => s.staff_id === sid); return !!x && x.kind !== "work"; };
  useEffect(() => { (async () => { setStore(await repo.store()); setStaff(await repo.staff()); repo.allStaff().then(setAllStaff).catch(() => {}); setLanes(await repo.lanes()); setResources(await repo.resources()); setMenus(await repo.menus()); setCustomers(await repo.customers()); })(); }, [repo]);
  useEffect(() => { if (view === 'day') void (async () => { await reload(); })(); }, [reload, view]);

  const open = store ? minutesOf(store.open_time) : 600, close = store ? minutesOf(store.close_time) : 1140;
  const axisStart = open - PRE_OPEN, axisEnd = close;
  const cells = useMemo(() => { const a: number[] = []; for (let m = axisStart; m < axisEnd; m += 15) a.push(m); return a; }, [axisStart, axisEnd]);
  const gridW = cells.length * CELL;
  const xOf = (minute: number) => ((minute - axisStart) / 15) * CELL;

  const custName = (b: Booking) => b.customer_name || customers.find(c => c.id === b.customer_id)?.name || "(名前なし)";
  const menuOf = (b: Booking) => menus.find(m => m.id === b.menu_ids[0]);
  const menuLabel = (b: Booking) => b.menu_ids.map(id => { const m = menus.find(x => x.id === id); return m ? (menuShort ? (m.short_name || m.name) : m.name) : ""; }).filter(Boolean).join("・");

  const today = todayStr();
  const dObj = new Date(`${date}T00:00:00`);
  const weekStart = addDays(date, -dObj.getDay());
  const week = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  const live = bookings.filter(b => b.status !== 'cancelled');
  const laneItems = (l: Lane) => live.filter(b => b.lane_id === l.id && b.status === 'block');
  const staffItems = (s: Staff) => live.filter(b => b.staff_id === s.id);
  // 退職・台帳非表示の人でも、この日に予約・ブロックが残っていれば行を出す（担当の付け替え用）
  const extraStaff = allStaff.filter(s => !staff.some(x => x.id === s.id) && live.some(b => b.staff_id === s.id));
  const rowStaff = [...staff, ...extraStaff];
  const extraTag = (s: Staff) => (s.active === false ? "退職" : "台帳に非表示");
  const laneFreeMin = (l: Lane) => {
    // IDLE の合計分 − この受付枠経由の予約の合計分（15分単位・目安）
    const idle = laneItems(l).filter(b => b.block_kind === 'idle').reduce((a, b) => a + (minOfIso(b.end_at) - minOfIso(b.start_at)), 0);
    const used = live.filter(b => b.lane_id === l.id && b.status !== 'block').reduce((a, b) => a + (minOfIso(b.end_at) - minOfIso(b.start_at)), 0);
    return Math.max(0, idle * l.capacity - used);
  };
  const dayTotal = live.filter(b => b.status !== 'block').length;

  // ---- ドラッグで範囲選択 ----
  function cellAt(e: React.PointerEvent<HTMLDivElement>) {
    const r = e.currentTarget.getBoundingClientRect();
    const m = axisStart + Math.floor((e.clientX - r.left) / CELL) * 15;
    return Math.min(axisEnd - 15, Math.max(axisStart, m));
  }
  function onDown(kind: 'lane'|'staff', id: string) { return (e: React.PointerEvent<HTMLDivElement>) => { if ((e.target as HTMLElement).closest('[data-item]')) return; const m = cellAt(e); drag.current = { kind, id, from: m }; setSel({ kind, id, from: m, to: m + 15 }); e.currentTarget.setPointerCapture(e.pointerId); }; }
  function onMove(e: React.PointerEvent<HTMLDivElement>) { if (!drag.current) return; const m = cellAt(e); const a = Math.min(drag.current.from, m), b = Math.max(drag.current.from, m) + 15; setSel({ kind: drag.current.kind, id: drag.current.id, from: a, to: b }); }
  function onUp() { drag.current = null; }

  async function placeBlock(kind: BlockKind) {
    if (!sel) return;
    await repo.createBooking({ store_id: store?.id || '', lane_id: sel.kind === 'lane' ? sel.id : null, staff_id: sel.kind === 'staff' ? sel.id : null, start_at: isoAt(date, sel.from), end_at: isoAt(date, sel.to), status: 'block', channel: 'block', block_kind: kind, menu_ids: [], nominated: false });
    setSel(null); await reload();
  }
  function newBookingFromSel() {
    if (!sel) return;
    setEditing({ staff_id: sel.kind === 'staff' ? sel.id : staff[0]?.id, lane_id: sel.kind === 'lane' ? sel.id : null, start_at: isoAt(date, sel.from), status: 'booked', channel: 'phone', menu_ids: [], nominated: false, resource_id: resources[0]?.id });
    setSel(null);
  }

  const badge = date === today ? { t: "今日", c: "bg-emerald-600" } : date > today ? { t: "未来の日付です", c: "bg-sky-500" } : { t: "過去の日付です", c: "bg-stone-500" };

  // ---- 1行（受付枠 or スタッフ）を描く ----
  function Row({ kind, id, label, items, free, sub, off, color, tag }: { kind: 'lane'|'staff'; id: string; label: string; items: Booking[]; free?: string; sub?: string; off?: boolean; color?: string|null; tag?: string }) {
    const { placed, rows } = layoutRows(items);
    const h = rows * SUB_H;
    const isSel = sel && sel.kind === kind && sel.id === id;
    return (
      <div className="flex border-b border-stone-300" style={{ minWidth: LABEL_W + gridW }}>
        <div className={`shrink-0 sticky left-0 z-10 border-r border-stone-300 px-2 py-1 text-xs flex flex-col justify-center ${off ? 'bg-stone-200' : 'bg-white'}`} style={{ width: LABEL_W, height: h }}>
          <div className={`font-semibold flex items-center gap-1 ${kind === 'lane' ? 'text-stone-700' : off || tag ? 'text-stone-500' : 'text-[#2f6b4f]'}`}>{color && <span className="inline-block w-2.5 h-2.5 rounded-full shrink-0" style={{ background: color }} />}<span className="truncate">{label}</span>{tag && <span className="px-1 rounded bg-stone-300 text-stone-700 text-[10px] whitespace-nowrap">{tag}</span>}{off && <span className="px-1 rounded bg-rose-100 text-rose-700 text-[10px] whitespace-nowrap">{sub}</span>}</div>
          {sub && !off && <div className="text-[10px] text-stone-500">{sub}</div>}
          {free && <div className="text-[10px] text-stone-500">{free}</div>}
        </div>
        <div className="relative select-none touch-none" style={{ width: gridW, height: h, cursor: 'crosshair' }} onPointerDown={onDown(kind, id)} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
          {cells.map((m, i) => <div key={m} className={`absolute top-0 bottom-0 border-r ${m % 60 === 45 ? 'border-stone-300' : 'border-stone-100'} ${m < open || off ? 'bg-stone-200/70' : (kind === 'lane' ? (i % 2 ? 'bg-sky-50/40' : '') : '')}`} style={{ left: i * CELL, width: CELL }} />)}
          {Array.from({ length: rows - 1 }, (_, r) => <div key={r} className="absolute left-0 right-0 border-t border-dashed border-stone-200" style={{ top: (r + 1) * SUB_H }} />)}
          {isSel && <div className="absolute rounded bg-amber-300/60 border-2 border-amber-500 z-20 pointer-events-none" style={{ left: xOf(sel!.from), width: xOf(sel!.to) - xOf(sel!.from), top: 1, height: h - 2 }} />}
          {placed.map(({ item: b, row }) => {
            const left = xOf(minOfIso(b.start_at)), w = Math.max(CELL, xOf(minOfIso(b.end_at)) - left);
            const style = { left, width: w - 2, top: row * SUB_H + 2, height: SUB_H - 4 } as const;
            if (b.status === 'block') {
              const k = BLOCK[b.block_kind || 'close'];
              return <div key={b.id} data-item onClick={() => setBlockEdit(b)} className="absolute rounded-sm text-[11px] font-bold flex items-center px-1 cursor-pointer shadow-sm" style={{ ...style, background: k.bg, color: k.fg }} title={`${k.label} ${hm(b.start_at)}–${hm(b.end_at)}${b.note === AUTO_IDLE_NOTE ? '（シフトから自動）' : ''}`}>{k.short}</div>;
            }
            const m = menuOf(b);
            return (
              <div key={b.id} data-item onClick={() => setEditing(b)} className={`absolute rounded-sm overflow-hidden cursor-pointer shadow-sm border text-[11px] leading-tight ${b.status === 'done' ? 'opacity-60' : ''} ${CHANNEL_COLOR[b.channel]}`} style={{ ...style, background: m?.color ? `${m.color}33` : undefined, borderColor: m?.color || undefined }} title={`${hm(b.start_at)}–${hm(b.end_at)} ${custName(b)} ${menuLabel(b)}`}>
                <div className="flex items-center gap-1 px-1 truncate">
                  <span className="px-1 rounded text-[9px] font-bold text-white" style={{ background: m?.color || '#777' }}>{CHANNEL_LABEL[b.channel]}</span>
                  <span className="font-semibold truncate">{custName(b)}{b.nominated ? "★" : ""}</span>
                </div>
                <div className="px-1 truncate text-[10px]" style={{ color: m?.color || '#444' }}>{menuLabel(b)}{b.status !== 'booked' ? `／${STATUS_LABEL[b.status]}` : ''}</div>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  const tabs = (
    <div className="inline-flex border rounded overflow-hidden" role="tablist">
      {(Object.keys(VIEW_LABEL) as View[]).map(v => <button key={v} role="tab" aria-selected={view === v} onClick={() => setView(v)} className={`px-3 py-1 text-sm border-r last:border-r-0 ${view === v ? 'bg-[#2f6b4f] text-white font-semibold' : 'bg-white hover:bg-stone-100'}`}>{VIEW_LABEL[v]}</button>)}
    </div>
  );
  if (view === 'week') return <div><div className="mb-2 flex flex-wrap items-center gap-2">{tabs}{inboxButton}</div>{inboxModal}<WeekView date={date} setDate={setDate} onPickDay={pickDay} store={store} staff={staff} allStaff={allStaff} lanes={lanes} menus={menus} customers={customers} /></div>;
  if (view === 'month') return <div><div className="mb-2 flex flex-wrap items-center gap-2">{tabs}{inboxButton}</div>{inboxModal}<MonthView date={date} setDate={setDate} onPickDay={pickDay} menus={menus} /></div>;

  return (
    <div>
      {/* ヘッダー：日付・移動・週ストリップ・凡例 */}
      <div className="flex flex-wrap items-center gap-2 mb-2">
        {tabs}
        <div className="text-xl font-bold tabular-nums">{date.replace(/-/g, '/')}（{WD[dObj.getDay()]}）</div>
        <span className={`text-[11px] text-white px-2 py-0.5 rounded ${badge.c}`}>{badge.t}</span>
        {inboxButton}
        <div className="flex gap-1 ml-2">
          <button className="btn" onClick={reload}>更新</button>
          <button className="btn" onClick={() => setDate(addDays(date, -1))}>前日</button>
          <button className="btn" onClick={() => setDate(today)}>今日</button>
          <button className="btn" onClick={() => setDate(addDays(date, 1))}>次日</button>
          <input type="date" className="inp" value={date} onChange={e => setDate(e.target.value)} />
        </div>
        <div className="flex border rounded overflow-hidden ml-1">
          {week.map(d => { const w = new Date(`${d}T00:00:00`).getDay(); const on = d === date; return (
            <button key={d} onClick={() => setDate(d)} className={`w-9 py-0.5 text-center text-xs leading-tight border-r last:border-r-0 ${on ? 'bg-amber-100 ring-2 ring-rose-400 ring-inset' : 'hover:bg-stone-100'} ${w === 0 ? 'text-rose-600' : w === 6 ? 'text-sky-600' : ''}`}>
              <div>{WD[w]}</div><div className="font-semibold">{Number(d.slice(-2))}</div>
            </button>); })}
        </div>
        <span className="text-sm text-stone-600 ml-1">予約 {dayTotal}件</span>
        <button className={`btn text-xs ${menuShort ? 'bg-stone-200' : ''}`} onClick={() => setMenuShort(v => !v)}>メニュー略名</button>
        <div className="ml-auto flex flex-wrap gap-1 text-[11px]">
          {(Object.keys(BLOCK) as BlockKind[]).map(k => <span key={k} className="px-1.5 rounded text-white" style={{ background: BLOCK[k].bg }}>● {BLOCK[k].label.split('（')[0]}</span>)}
          {menus.filter(m => m.category === 'technical').map(m => <span key={m.id} className="px-1.5 rounded text-white" style={{ background: m.color || '#999' }}>● {m.short_name || m.name}</span>)}
        </div>
      </div>

      {/* グリッド */}
      <div className="overflow-auto border rounded bg-white" style={{ maxHeight: "74vh" }}>
        <div style={{ width: LABEL_W + gridW }}>
          <div className="flex sticky top-0 z-30 bg-stone-100 border-b border-stone-300">
            <div className="shrink-0 sticky left-0 z-10 bg-stone-100 border-r border-stone-300 text-[10px] text-stone-500 px-2 flex items-end pb-0.5" style={{ width: LABEL_W, height: 26 }}>残数 ▾</div>
            <div className="relative" style={{ width: gridW, height: 26 }}>
              {cells.map((m, i) => <div key={m} className={`absolute top-0 bottom-0 border-r ${m % 60 === 45 ? 'border-stone-300' : 'border-transparent'}`} style={{ left: i * CELL, width: CELL }}>{m % 60 === 0 && <span className="absolute left-1 top-1 text-xs font-semibold text-stone-700">{fmtMin(m)}</span>}</div>)}
            </div>
          </div>
          {lanes.filter(l => l.sort_order === 1 || lanes.length === 1).map(l => <Row key={l.id} kind="lane" id={l.id} label={l.name} items={laneItems(l)} free={`空き 約${(laneFreeMin(l)/60).toFixed(1)}h`} />)}
          {staff.map(s => <Row key={s.id} kind="staff" id={s.id} label={s.name} color={s.color} items={staffItems(s)} sub={shiftLabel(s.id)} off={isOff(s.id)} free={`${staffItems(s).filter(b => b.status !== 'block').length}件`} />)}
          {extraStaff.map(s => <Row key={s.id} kind="staff" id={s.id} label={s.name} color={s.color} tag={extraTag(s)} items={staffItems(s)} free={`${staffItems(s).filter(b => b.status !== 'block').length}件・付け替えてください`} />)}
          {lanes.filter(l => !(l.sort_order === 1 || lanes.length === 1)).map(l => <Row key={l.id} kind="lane" id={l.id} label={l.name} items={laneItems(l)} free={`空き 約${(laneFreeMin(l)/60).toFixed(1)}h`} />)}
        </div>
      </div>
      <div className="text-[11px] text-stone-500 mt-1">行の上をドラッグして時間を選ぶ → IDLE／×／BREAK／保証／予約 を置けます。ブロックはクリックで変更・削除。</div>

      {/* 範囲選択のポップ */}
      {sel && !editing && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-40 bg-white border shadow-xl rounded-lg p-3 flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold">{fmtMin(sel.from)}〜{fmtMin(sel.to)}（{sel.kind === 'lane' ? lanes.find(l => l.id === sel.id)?.name : rowStaff.find(s => s.id === sel.id)?.name}）</span>
          {sel.kind === 'lane' && <>
            <button className="px-3 py-1.5 rounded text-sm font-bold text-white" style={{ background: BLOCK.idle.bg }} onClick={() => placeBlock('idle')}>IDLE 受付中にする</button>
            <button className="px-3 py-1.5 rounded text-sm font-bold text-white" style={{ background: BLOCK.close.bg }} onClick={() => placeBlock('close')}>× 受付停止</button>
          </>}
          {sel.kind === 'staff' && <>
            <button className="btn-primary" onClick={newBookingFromSel}>予約を入れる</button>
            <button className="px-3 py-1.5 rounded text-sm font-bold text-white" style={{ background: BLOCK.break.bg }} onClick={() => placeBlock('break')}>BREAK</button>
            <button className="px-3 py-1.5 rounded text-sm font-bold text-white" style={{ background: BLOCK.guarantee.bg }} onClick={() => placeBlock('guarantee')}>保証</button>
            <button className="px-3 py-1.5 rounded text-sm font-bold text-white" style={{ background: BLOCK.close.bg }} onClick={() => placeBlock('close')}>×</button>
          </>}
          <button className="btn" onClick={() => setSel(null)}>やめる</button>
        </div>
      )}

      {/* ブロック編集 */}
      {blockEdit && (
        <div className="fixed inset-0 bg-black/30 z-40 flex items-center justify-center" onClick={() => setBlockEdit(null)}>
          <div className="bg-white rounded-xl p-4 w-full max-w-sm" onClick={e => e.stopPropagation()}>
            <div className="font-bold mb-2">{BLOCK[blockEdit.block_kind || 'close'].label}　{hm(blockEdit.start_at)}〜{hm(blockEdit.end_at)}</div>
            <div className="grid grid-cols-2 gap-2 mb-3">
              <div><label className="lbl">開始</label><input type="time" step={900} className="inp w-full" defaultValue={hm(blockEdit.start_at)} onChange={e => setBlockEdit({ ...blockEdit, start_at: new Date(`${date}T${e.target.value}:00`).toISOString() })} /></div>
              <div><label className="lbl">終了</label><input type="time" step={900} className="inp w-full" defaultValue={hm(blockEdit.end_at)} onChange={e => setBlockEdit({ ...blockEdit, end_at: new Date(`${date}T${e.target.value}:00`).toISOString() })} /></div>
            </div>
            <label className="lbl">種類を変える</label>
            <div className="flex flex-wrap gap-1 mb-3">
              {(Object.keys(BLOCK) as BlockKind[]).filter(k => blockEdit.lane_id ? (k === 'idle' || k === 'close') : k !== 'idle').map(k => <button key={k} className={`px-2 py-1 rounded text-xs font-bold text-white ${blockEdit.block_kind === k ? 'ring-2 ring-offset-1 ring-stone-600' : ''}`} style={{ background: BLOCK[k].bg }} onClick={() => setBlockEdit({ ...blockEdit, block_kind: k })}>{BLOCK[k].label}</button>)}
            </div>
            <div className="flex justify-between">
              <button className="btn text-rose-600" onClick={async () => { await repo.deleteBooking(blockEdit.id); setBlockEdit(null); reload(); }}>削除</button>
              <div className="flex gap-2"><button className="btn" onClick={() => setBlockEdit(null)}>閉じる</button><button className="btn-primary" onClick={async () => { await repo.updateBooking(blockEdit.id, { start_at: blockEdit.start_at, end_at: blockEdit.end_at, block_kind: blockEdit.block_kind }); setBlockEdit(null); reload(); }}>保存</button></div>
            </div>
          </div>
        </div>
      )}

      {inboxModal}
      {editing && (
        <BookingEditor init={editing} date={date} shifts={dayShifts} staff={staff} allStaff={allStaff} lanes={lanes} resources={resources} menus={menus} customers={customers}
          onClose={() => setEditing(null)}
          onSaved={async () => { setEditing(null); await reload(); }}
          onCheckout={(id) => router.push(`/pos?booking=${id}`)}
          onNewCustomer={async (name) => { const c = await repo.upsertCustomer({ name }); setCustomers(await repo.customers()); return c; }}
        />
      )}
    </div>
  );
}

function BookingEditor({ init, date, shifts, staff, allStaff, lanes, resources, menus, customers, onClose, onSaved, onCheckout, onNewCustomer }: {
  init: Partial<Booking>; date: string; shifts: Shift[]; staff: Staff[]; allStaff: Staff[]; lanes: Lane[]; resources: Resource[]; menus: Menu[]; customers: Customer[];
  onClose: () => void; onSaved: () => void; onCheckout: (id: string) => void; onNewCustomer: (name: string) => Promise<Customer>;
}) {
  const repo = getRepo();
  const [b, setB] = useState<Partial<Booking>>(init);
  const [q, setQ] = useState("");
  const [err, setErr] = useState("");
  const isNew = !b.id;
  const dur = (b.menu_ids || []).reduce((a, id) => { const m = menus.find(x => x.id === id); return a + (m ? m.duration_min + m.interval_min : 0); }, 0);
  const price = (b.menu_ids || []).reduce((a, id) => a + (menus.find(x => x.id === id)?.price || 0), 0);
  const startHM = b.start_at ? hm(b.start_at) : "10:00";
  function setStart(t: string) { setB({ ...b, start_at: new Date(`${date}T${t}:00`).toISOString() }); }
  const cands = q ? customers.filter(c => (c.name + (c.kana||'') + (c.phone||'')).includes(q)).slice(0, 6) : [];
  const customer = customers.find(c => c.id === b.customer_id);
  const [ask, setAsk] = useState<string | null>(null);
  // 休みの人・シフト時間外への予約は警告（保存はできる）
  const shiftWarn = (() => {
    if (!b.staff_id) return null;
    const who = allStaff.find(s => s.id === b.staff_id)?.name || staff.find(s => s.id === b.staff_id)?.name || "担当";
    const gone = allStaff.find(s => s.id === b.staff_id && s.active === false);
    if (gone && b.status !== "done") return `${gone.name}さんは退職しています。担当を付け替えてください。`;
    const sh = shifts.find(s => s.staff_id === b.staff_id);
    if (!sh) return null;
    if (sh.kind !== "work") return `${who}さんはこの日「${KIND_LABEL[sh.kind]}」です。`;
    if (b.start_at && sh.start_time && sh.end_time) {
      const st = hm(b.start_at); const endMin = Number(st.slice(0, 2)) * 60 + Number(st.slice(3)) + Math.max(dur, 15);
      const en = `${String(Math.floor(endMin / 60)).padStart(2, "0")}:${String(endMin % 60).padStart(2, "0")}`;
      if (st < sh.start_time || en > sh.end_time) return `${who}さんのシフト（${sh.start_time}〜${sh.end_time}）の時間外です。`;
      if (sh.break_start && sh.break_end && st < sh.break_end && en > sh.break_start) return `${who}さんの休憩（${sh.break_start}〜${sh.break_end}）と重なっています。`;
    }
    return null;
  })();

  async function save(force = false) {
    if (shiftWarn && !force && b.status !== 'done') { setAsk(shiftWarn); return; }
    setAsk(null);
    try {
      if (!b.start_at) throw new Error("開始時刻を入れてください");
      if (!(b.menu_ids||[]).length) throw new Error("メニューを選んでください");
      if (!b.staff_id) throw new Error("担当を選んでください");
      const start = new Date(b.start_at); const end = new Date(start.getTime() + Math.max(dur, 15) * 60000);
      const payload = { ...b, end_at: end.toISOString(), store_id: b.store_id || '', menu_ids: b.menu_ids || [], nominated: !!b.nominated, status: b.status || 'booked', channel: (b.channel || 'phone') as Channel } as Omit<Booking,'id'|'created_at'|'updated_at'>;
      if (isNew) await repo.createBooking(payload); else await repo.updateBooking(b.id!, payload);
      onSaved();
    } catch (e) { setErr((e as Error).message); }
  }
  async function setStatus(s: Booking['status']) { await repo.updateBooking(b.id!, { status: s }); onSaved(); }

  return (
    <div className="fixed inset-0 bg-black/30 z-40 flex items-end sm:items-center justify-center" onClick={onClose}>
      <div className="bg-white w-full sm:max-w-lg rounded-t-xl sm:rounded-xl p-4 max-h-[92vh] overflow-auto" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-2"><h2 className="font-bold">{isNew ? "新しい予約" : "予約の詳細"}</h2><button className="btn" onClick={onClose}>閉じる</button></div>
        {err && <div className="text-rose-600 text-sm mb-2">{err}</div>}
        {shiftWarn && <div className="mb-2 text-sm px-3 py-2 rounded bg-amber-50 border border-amber-300 text-amber-900">⚠ {shiftWarn}</div>}
        {(b.booking_no || (b.intake && b.intake.length > 0)) && (
          <div className="mb-2 text-sm px-3 py-2 rounded bg-emerald-50 border border-emerald-200">
            <div className="font-semibold text-emerald-900">ネット予約 {b.booking_no}{b.price_quote != null && <span className="font-normal text-stone-700">　予約時の料金 ¥{b.price_quote.toLocaleString()}</span>}{b.coupon_id && <span className="ml-1 text-[11px] px-1.5 rounded bg-rose-100 text-rose-800">クーポンあり</span>}</div>
            {b.intake && b.intake.length > 0 && <div className="mt-1"><div className="text-xs text-stone-500">事前問診</div><ul className="text-xs">{b.intake.map(a => <li key={a.label}><span className="text-stone-500">{a.label}：</span>{a.answer}</li>)}</ul></div>}
          </div>
        )}
        <label className="lbl">お客様</label>
        {customer ? <div className="flex items-center gap-2 mb-2"><span className="font-semibold">{customer.name}</span><span className="text-xs text-stone-500">{customer.phone}</span><button className="btn text-xs" onClick={() => setB({ ...b, customer_id: null })}>変更</button></div>
          : <div className="mb-2 relative">
              <input className="inp w-full" placeholder="名前・カナ・電話で検索／新規は名前を入れて「新規登録」" value={q} onChange={e => setQ(e.target.value)} />
              {cands.length > 0 && <div className="absolute z-10 bg-white border rounded w-full shadow">{cands.map(c => <div key={c.id} className="px-2 py-1 hover:bg-emerald-50 cursor-pointer text-sm" onClick={() => { setB({ ...b, customer_id: c.id, customer_name: null }); setQ(""); }}>{c.name} <span className="text-xs text-stone-500">{c.phone}</span></div>)}</div>}
              {q && <button className="btn text-xs mt-1" onClick={async () => { const c = await onNewCustomer(q); setB({ ...b, customer_id: c.id }); setQ(""); }}>「{q}」を新規登録</button>}
            </div>}
        <div className="grid grid-cols-2 gap-2">
          <div><label className="lbl">担当</label><select className="inp w-full" value={b.staff_id || ''} onChange={e => setB({ ...b, staff_id: e.target.value })}><option value="">—</option>{staff.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}{b.staff_id && !staff.some(s => s.id === b.staff_id) && <option value={b.staff_id}>{staffLabel(allStaff.find(s => s.id === b.staff_id))}</option>}</select></div>
          <div><label className="lbl">部屋・ベッド</label><select className="inp w-full" value={b.resource_id || ''} onChange={e => setB({ ...b, resource_id: e.target.value })}>{resources.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}</select></div>
          <div><label className="lbl">開始</label><input type="time" step={900} className="inp w-full" value={startHM} onChange={e => setStart(e.target.value)} /></div>
          <div><label className="lbl">経路</label><select className="inp w-full" value={b.channel || 'phone'} onChange={e => setB({ ...b, channel: e.target.value as Channel })}>{Object.entries(CHANNEL_LABEL).filter(([k]) => k !== 'block').map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div>
          <div><label className="lbl">受付枠（ネット予約の場合）</label><select className="inp w-full" value={b.lane_id || ''} onChange={e => setB({ ...b, lane_id: e.target.value || null })}><option value="">なし（電話・来店）</option>{lanes.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}</select></div>
          <div><label className="lbl">外部予約番号</label><input className="inp w-full" placeholder="HPB/Viator/Klook の番号" value={b.external_ref || ''} onChange={e => setB({ ...b, external_ref: e.target.value })} /></div>
        </div>
        <label className="lbl mt-2">メニュー（{dur}分・¥{price.toLocaleString()}）</label>
        <div className="flex flex-wrap gap-1 mb-2">
          {menus.map(m => { const on = (b.menu_ids||[]).includes(m.id); return <button key={m.id} className={`px-2 py-1 rounded border text-xs ${on ? 'text-white' : 'bg-white'}`} style={on ? { background: m.color || '#2f6b4f', borderColor: m.color || '#2f6b4f' } : { borderColor: m.color || '#ccc' }} onClick={() => setB({ ...b, menu_ids: on ? (b.menu_ids||[]).filter(x => x !== m.id) : [...(b.menu_ids||[]), m.id] })}>{m.name} {m.price.toLocaleString()}</button>; })}
        </div>
        <label className="inline-flex items-center gap-1 text-sm mb-2"><input type="checkbox" checked={!!b.nominated} onChange={e => setB({ ...b, nominated: e.target.checked })} />指名</label>
        <input className="inp w-full mb-2" placeholder="メモ" value={b.note || ''} onChange={e => setB({ ...b, note: e.target.value })} />
        <div className="flex flex-wrap gap-2 justify-end">
          {!isNew && b.status === 'booked' && <button className="btn" onClick={() => setStatus('arrived')}>来店</button>}
          {!isNew && b.status !== 'done' && <button className="btn text-rose-600" onClick={() => { if (confirm('キャンセルしますか？')) setStatus('cancelled'); }}>キャンセル</button>}
          {!isNew && b.status !== 'done' && <button className="btn" onClick={() => onCheckout(b.id!)}>会計へ</button>}
          <button className="btn-primary" onClick={() => save()}>{isNew ? "予約を入れる" : "保存"}</button>
        </div>
        {ask && (
          <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-3" onClick={e => { e.stopPropagation(); setAsk(null); }}>
            <div role="alertdialog" aria-label="シフトの確認" className="bg-white rounded-xl p-4 w-full max-w-sm shadow-2xl border-t-4 border-amber-500" onClick={e => e.stopPropagation()}>
              <div className="font-bold mb-1">シフトの確認</div>
              <div className="text-sm mb-1">{ask}</div>
              <div className="text-sm text-stone-600 mb-3">このまま予約を入れますか？（シフトの変更が必要なら、先にシフト画面で直してください）</div>
              <div className="flex justify-end gap-2"><button className="btn" onClick={() => setAsk(null)}>やめる</button><button className="btn-primary bg-amber-600 hover:bg-amber-700" onClick={() => save(true)}>それでも保存する</button></div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
