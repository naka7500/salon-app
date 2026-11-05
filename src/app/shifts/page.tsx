"use client";
// シフト入力：月間表（縦＝スタッフ、横＝日）。セルを押して勤務パターンを選ぶ。
// 「確定」でその月の受付枠（IDLE）を出勤人数に合わせて自動で並べる。
import { useCallback, useEffect, useMemo, useState } from "react";
import { getRepo, todayStr, type Staff, type Shift, type ShiftPattern, type ShiftKind, type ShiftInput, type ShiftMonth, type Store, type Menu, type Capabilities } from "@/lib/db";
import { WD, KIND_LABEL, addDays, addMonths, dow, monthDays, toMin, confirmShiftMonth, lastOrderOffset, breakMin } from "@/lib/schedule";

const CELL_W = 40;
const NAME_W = 104;   // 名前が5〜6文字でも切れないように（スタッフ設定で長い名前も登録できる）

function textOn(hex: string) { const h = hex.replace("#", ""); if (h.length < 6) return "#111"; const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16); return (r * 299 + g * 587 + b * 114) / 1000 > 150 ? "#1c1917" : "#fff"; }
function downloadCsv(name: string, rows: (string | number)[][]) {
  const csv = "﻿" + rows.map(r => r.map(v => { const s = String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }).join(",")).join("\r\n");
  const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" })); a.download = name; a.click(); URL.revokeObjectURL(a.href);
}

export default function ShiftsPage() {
  const repo = getRepo();
  const [ym, setYm] = useState(todayStr().slice(0, 7));
  const days = useMemo(() => monthDays(ym), [ym]);
  const [storeName, setStoreName] = useState("");
  const [staff, setStaff] = useState<Staff[]>([]);
  const [allStaff, setAllStaff] = useState<Staff[]>([]);
  const [patterns, setPatterns] = useState<ShiftPattern[]>([]);
  const [shifts, setShifts] = useState<Shift[]>([]);
  const [month, setMonth] = useState<ShiftMonth | undefined>();
  const [tab, setTab] = useState<"shift" | "break">("shift");
  const [brush, setBrush] = useState<string | null>(null);      // 選んだパターンで連続入力
  const [pick, setPick] = useState<{ staff_id: string; date: string } | null>(null);
  const [showBulk, setShowBulk] = useState(false);
  const [showPatterns, setShowPatterns] = useState(false);
  const [msg, setMsg] = useState<{ t: string; ok: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [store, setStore] = useState<Store | null>(null);
  const [menus, setMenus] = useState<Menu[]>([]);
  const [caps, setCaps] = useState<Capabilities>({ goals: false, shiftBreaks: false, lastOrder: false, phaseC: false, staffSettings: false, v11: false });
  const [showLast, setShowLast] = useState(false);

  const reload = useCallback(async () => {
    const to = addDays(days[days.length - 1], 1);
    const [s, m] = await Promise.all([repo.shiftsBetween(days[0], to), repo.shiftMonth(ym)]);
    setShifts(s); setMonth(m);
  }, [repo, days, ym]);
  useEffect(() => { (async () => { const st = await repo.store(); setStore(st); setStoreName(st.name); setStaff(await repo.staff()); repo.allStaff().then(setAllStaff).catch(() => {}); setPatterns(await repo.shiftPatterns()); setMenus(await repo.menus()); setCaps(await repo.capabilities()); })(); }, [repo]);
  const last = lastOrderOffset(store, menus);
  useEffect(() => { void (async () => { await reload(); })(); }, [reload]);
  const changeYm = (v: string) => { setYm(v); setDirty(false); setMsg(null); };

  const cellOf = (sid: string, d: string) => shifts.find(s => s.staff_id === sid && s.date === d);
  const patOf = (s?: Shift) => s && (patterns.find(p => p.id === s.pattern_id) || patterns.find(p => p.kind === s.kind && (s.kind !== "work" || (p.start_time === s.start_time && p.end_time === s.end_time))));
  const rowFrom = (p: ShiftPattern, staff_id: string, date: string, prev?: Shift): ShiftInput =>
    ({ staff_id, date, kind: p.kind, pattern_id: p.id, start_time: p.kind === "work" ? p.start_time : null, end_time: p.kind === "work" ? p.end_time : null, is_store_closed: p.kind === "closed", break_missed: p.kind === "work" ? !!prev?.break_missed : false,
      ...(caps.shiftBreaks ? { break_start: p.kind === "work" ? prev?.break_start ?? null : null, break_end: p.kind === "work" ? prev?.break_end ?? null : null } : {}) });

  async function apply(rows: ShiftInput[], clear: { staff_id: string; date: string }[] = []) {
    setBusy(true);
    try { if (clear.length) await repo.deleteShifts(clear); if (rows.length) await repo.saveShifts(rows); await reload(); if (month) setDirty(true); }
    catch (e) { setMsg({ t: (e as Error).message, ok: false }); }
    finally { setBusy(false); }
  }
  function onCell(staff_id: string, date: string) {
    if (tab === "break") return;
    const p = patterns.find(x => x.id === brush);
    if (p) apply([rowFrom(p, staff_id, date, cellOf(staff_id, date))]); else setPick({ staff_id, date });
  }
  function onDayHeader(date: string) {
    const p = patterns.find(x => x.id === brush);
    if (p && tab === "shift") apply(staff.map(s => rowFrom(p, s.id, date, cellOf(s.id, date))));
  }

  async function copyLastMonth() {
    const prev = addMonths(ym, -1);
    const pDays = monthDays(prev);
    const src = await repo.shiftsBetween(pDays[0], days[0]);
    if (!src.length) { setMsg({ t: "先月のシフトがありません", ok: false }); return; }
    if (shifts.length && !confirm("今月の入力を、先月の同じ曜日の内容で上書きします。よろしいですか？")) return;
    // 同じ曜日になるよう4週前（月末は5週前）の日を写す
    const rows: ShiftInput[] = [];
    for (const d of days) {
      let s = addDays(d, -28); if (s >= days[0]) s = addDays(d, -35);
      for (const x of src.filter(x => x.date === s && x.staff_id && staff.some(st => st.id === x.staff_id)))
        rows.push({ staff_id: x.staff_id!, date: d, kind: x.kind, pattern_id: x.pattern_id ?? null, start_time: x.start_time ?? null, end_time: x.end_time ?? null, is_store_closed: x.is_store_closed, break_missed: false, ...(caps.shiftBreaks ? { break_start: x.break_start ?? null, break_end: x.break_end ?? null } : {}) });
    }
    await apply(rows, shifts.filter(x => x.staff_id).map(x => ({ staff_id: x.staff_id!, date: x.date })));
    setMsg({ t: `先月（${prev.replace("-", "/")}）の曜日どおりに ${rows.length}件 コピーしました`, ok: true });
  }

  async function confirmMonth() {
    if (!confirm(`このシフトで確定し、受付枠（IDLE）を自動で並べます。\n・出勤1名の時間 → 1名様枠\n・出勤2名以上の時間 → 1名様枠＋ペア枠\n・最終受付：シフト終了の${last.min}分前で締める${caps.shiftBreaks ? "（休憩中も閉じる）" : ""}\n手で置いた受付枠がある日はそのままにします。\n※空き（ネット予約・電話予約）は「出勤中で空いている人数×空き部屋」で自動で数えます。IDLEは目安の表示です。`)) return;
    setBusy(true);
    try {
      const r = await confirmShiftMonth(repo, ym);
      await reload(); setDirty(false);
      const sk = r.skipped.length ? `。手で置いた受付枠がある ${r.skipped.length}日（${r.skipped.map(d => Number(d.slice(8))).join("・")}日）はそのままです` : "";
      setMsg({ t: `確定しました。${r.madeDays}日分の受付枠（IDLE ${r.made}本）を並べました（最終受付＝終了の${r.offset.min}分前）${sk}`, ok: true });
    } catch (e) { setMsg({ t: (e as Error).message, ok: false }); }
    finally { setBusy(false); }
  }

  // 退職・台帳非表示の人でも、この月にシフトがあれば見るだけの行を出す（給与の集計用）
  const extraStaff = allStaff.filter(s => !staff.some(x => x.id === s.id) && shifts.some(x => x.staff_id === s.id));
  const staffRows = [...staff, ...extraStaff];
  // ---- 集計・CSV ----
  const sum = (sid: string) => {
    const ss = shifts.filter(s => s.staff_id === sid);
    const work = ss.filter(s => s.kind === "work");
    return { work: work.length, paid: ss.filter(s => s.kind === "paid").length, off: ss.filter(s => s.kind === "off").length, closed: ss.filter(s => s.kind === "closed").length,
      hours: work.reduce((a, s) => a + Math.max(0, toMin(s.end_time) - toMin(s.start_time)) - breakMin(s), 0) / 60, breakMissed: work.filter(s => s.break_missed).length };
  };
  function csvSummary() {
    downloadCsv(`シフト集計_${storeName}_${ym}.csv`, [["年月", "スタッフ", "出勤日数", "有給日数", "休み日数", "店休日数", "出勤時間(h)", "休憩未取得日数"],
      ...staffRows.map(s => { const x = sum(s.id); return [ym, s.name, x.work, x.paid, x.off, x.closed, x.hours.toFixed(2), x.breakMissed]; })]);
  }
  function csvDaily() {
    const rows: (string | number)[][] = [["日付", "曜日", "スタッフ", "区分", "パターン", "開始", "終了", "休憩開始", "休憩終了", "休憩未取得"]];
    for (const d of days) for (const s of staffRows) { const c = cellOf(s.id, d); if (!c) continue; rows.push([d, WD[dow(d)], s.name, KIND_LABEL[c.kind], patOf(c)?.name || "", c.start_time || "", c.end_time || "", c.break_start || "", c.break_end || "", c.break_missed ? "○" : ""]); }
    downloadCsv(`シフト日別_${storeName}_${ym}.csv`, rows);
  }

  const today = todayStr();
  const missingDays = days.filter(d => !shifts.some(s => s.date === d)).length;
  const head = (
    <div className="flex sticky top-0 z-20 bg-stone-100 border-b">
      <div className="shrink-0 sticky left-0 z-10 bg-stone-100 border-r px-2 text-xs text-stone-500 flex items-end pb-1" style={{ width: NAME_W, height: 40 }}>スタッフ</div>
      {days.map(d => { const w = dow(d); return (
        <button key={d} onClick={() => onDayHeader(d)} title={brush ? "この日の全員に入れる" : ""} className={`shrink-0 border-r text-center leading-tight text-xs ${d === today ? "bg-amber-200" : ""} ${brush && tab === "shift" ? "hover:bg-amber-100 cursor-pointer" : "cursor-default"}`} style={{ width: CELL_W, height: 40 }}>
          <div className="font-semibold">{Number(d.slice(8))}</div><div className={w === 0 ? "text-rose-600" : w === 6 ? "text-sky-700" : "text-stone-500"}>{WD[w]}</div>
        </button>); })}
      <div className="shrink-0 border-r text-center text-[11px] text-stone-600 flex items-center justify-center" style={{ width: 46 }}>出勤</div>
      <div className="shrink-0 text-center text-[11px] text-stone-600 flex items-center justify-center" style={{ width: 46 }}>{tab === "break" ? "未取得" : "有給"}</div>
    </div>
  );

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 mb-2">
        <h1 className="text-xl font-bold">シフト</h1>
        <div className="flex gap-1">
          <button className="btn" onClick={() => changeYm(addMonths(ym, -1))}>前月</button>
          <input type="month" className="inp" value={ym} onChange={e => e.target.value && changeYm(e.target.value)} />
          <button className="btn" onClick={() => changeYm(addMonths(ym, 1))}>次月</button>
        </div>
        <div className="flex border rounded overflow-hidden">
          {([["shift", "シフト"], ["break", "休憩未取得"]] as const).map(([k, l]) => <button key={k} onClick={() => { setTab(k); setBrush(null); }} className={`px-3 py-1 text-sm border-r last:border-r-0 ${tab === k ? "bg-canopy text-white font-semibold" : "bg-white hover:bg-stone-100"}`}>{l}</button>)}
        </div>
        <div className="ml-auto flex flex-wrap gap-1">
          <button className="btn" disabled={busy} onClick={copyLastMonth}>先月をコピー</button>
          <button className="btn" disabled={busy} onClick={() => setShowBulk(true)}>曜日で一括入力</button>
          <button className="btn" onClick={() => setShowPatterns(true)}>パターン設定</button>
          <button className="btn" onClick={csvSummary}>CSV（集計）</button>
          <button className="btn" onClick={csvDaily}>CSV（日別）</button>
          <button className="btn-primary" disabled={busy || !shifts.length} onClick={confirmMonth}>確定</button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 mb-2 text-xs">
        {month ? <span className={`px-2 py-0.5 rounded ${dirty ? "bg-amber-100 text-amber-800" : "bg-emerald-100 text-emerald-800"}`}>{dirty ? "確定後に変更があります。もう一度「確定」を押してください" : `確定済み（${new Date(month.confirmed_at).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}）`}</span>
          : <span className="px-2 py-0.5 rounded bg-stone-200 text-stone-700">未確定</span>}
        {missingDays > 0 && <span className="px-2 py-0.5 rounded bg-amber-100 text-amber-800">！未入力の日 {missingDays}日</span>}
        <button onClick={() => setShowLast(true)} className="px-2 py-0.5 rounded border border-stone-300 bg-white hover:bg-stone-100" title="受付枠IDLEをシフト終了の何分前で閉じるか">
          最終受付：終了の<b>{last.min}分前</b>{last.auto ? `（自動：最短メニュー${last.menu ? `「${last.menu.short_name || last.menu.name}」` : ""}）` : "（店舗設定）"} ✎
        </button>
        {tab === "shift" && <>
          <span className="text-stone-500 ml-2">連続入力：</span>
          {patterns.map(p => <button key={p.id} onClick={() => setBrush(brush === p.id ? null : p.id)} className={`px-2 py-0.5 rounded font-semibold ${brush === p.id ? "ring-2 ring-offset-1 ring-stone-700" : ""}`} style={{ background: p.color, color: textOn(p.color) }} title={p.kind === "work" ? `${p.start_time}〜${p.end_time}` : KIND_LABEL[p.kind]}>{p.name}</button>)}
          <span className="text-stone-500">{brush ? "← 選択中。セルを押すと入ります（日付を押すと全員）" : "← 選ぶとセルを押すだけで入ります"}</span>
        </>}
        {tab === "break" && <span className="text-stone-500">休憩が取れなかった日にチェック（出勤日だけ）。給与の休憩手当に使います。</span>}
      </div>
      {msg && <div className={`mb-2 text-sm px-3 py-2 rounded ${msg.ok ? "bg-emerald-50 text-emerald-800 border border-emerald-200" : "bg-rose-50 text-rose-700 border border-rose-200"}`}>{msg.t}</div>}

      <div className="overflow-auto border rounded bg-white" style={{ maxHeight: "70vh" }}>
        <div style={{ width: NAME_W + days.length * CELL_W + 92 }}>
          {head}
          {staffRows.map(s => { const x = sum(s.id); const ro = !staff.includes(s); return (
            <div key={s.id} className={`flex border-b ${ro ? "opacity-60" : ""}`}>
              <div className={`shrink-0 sticky left-0 z-10 bg-white border-r px-2 text-sm font-semibold flex items-center gap-1 ${ro ? "text-stone-500" : "text-canopy"}`} style={{ width: NAME_W, height: 44, boxShadow: s.color ? `inset 3px 0 0 ${s.color}` : undefined }} title={ro ? "退職・台帳に非表示の人（見るだけ）" : s.name}><span className="truncate">{s.name}</span>{ro && <span className="text-[9px] px-1 rounded bg-stone-300 text-stone-700 whitespace-nowrap">{s.active === false ? "退職" : "非表示"}</span>}</div>
              {days.map(d => {
                const c = cellOf(s.id, d); const p = patOf(c);
                if (tab === "break") {
                  const can = c?.kind === "work";
                  return <label key={d} className={`shrink-0 border-r flex items-center justify-center ${can ? "cursor-pointer hover:bg-amber-50" : "bg-stone-100"}`} style={{ width: CELL_W, height: 44 }} title={can ? "休憩未取得" : "出勤日ではありません"}>
                    {can && <input type="checkbox" disabled={ro} className="w-4 h-4 accent-rose-600" checked={!!c!.break_missed} onChange={e => { const { id: _i, store_id: _s, ...rest } = c!; void _i; void _s; apply([{ ...rest, staff_id: s.id, break_missed: e.target.checked }]); }} />}
                  </label>;
                }
                return (
                  <button key={d} onClick={() => onCell(s.id, d)} disabled={busy || ro} className={`shrink-0 border-r p-0.5 ${d === today ? "bg-amber-50" : ""} hover:ring-2 hover:ring-inset hover:ring-amber-400`} style={{ width: CELL_W, height: 44 }}
                    title={c ? `${p?.name || KIND_LABEL[c.kind]}${c.kind === "work" ? ` ${c.start_time}〜${c.end_time}` : ""}${c.break_start ? `（休憩 ${c.break_start}〜${c.break_end}）` : ""}` : "未入力"}>
                    {c ? <div className="w-full h-full rounded-sm flex flex-col items-center justify-center leading-none" style={{ background: p?.color || "#ccc", color: textOn(p?.color || "#ccc") }}>
                      <span className="text-[11px] font-bold">{p?.name || KIND_LABEL[c.kind]}</span>
                      {c.kind === "work" && <span className="text-[8px] mt-0.5 opacity-90">{c.start_time?.replace(/^0/, "")}{c.break_start ? " 休" : ""}</span>}
                    </div> : <span className="text-stone-300 text-xs">—</span>}
                  </button>
                );
              })}
              <div className="shrink-0 border-r text-center text-sm flex items-center justify-center tabular-nums" style={{ width: 46 }}>{x.work}</div>
              <div className="shrink-0 text-center text-sm flex items-center justify-center tabular-nums" style={{ width: 46 }}>{tab === "break" ? x.breakMissed : x.paid}</div>
            </div>); })}
          {/* 日ごとの出勤人数 */}
          <div className="flex bg-stone-50">
            <div className="shrink-0 sticky left-0 z-10 bg-stone-50 border-r px-2 text-[11px] text-stone-500 flex items-center" style={{ width: NAME_W, height: 28 }}>出勤人数</div>
            {days.map(d => { const n = shifts.filter(s => s.date === d && s.kind === "work").length; const closed = shifts.some(s => s.date === d) && shifts.filter(s => s.date === d).every(s => s.kind === "closed");
              return <div key={d} className={`shrink-0 border-r text-center text-xs flex items-center justify-center tabular-nums ${closed ? "bg-stone-300 text-stone-600" : n === 0 ? "text-stone-300" : "font-semibold"}`} style={{ width: CELL_W, height: 28 }}>{closed ? "休" : n}</div>; })}
          </div>
        </div>
      </div>
      <div className="text-[11px] text-stone-500 mt-1">「確定」を押すと予約台帳の受付枠（IDLE）を並べます（目安の表示）。空きはシフトの出勤人数・休憩・予約から自動で数えるので、IDLEを置かなくても受け付けます（シフトが無い日だけIDLEの中で受付）。予約台帳で手で置いた受付枠がある日は上書きしません。</div>

      {pick && <PatternPicker patterns={patterns} cur={cellOf(pick.staff_id, pick.date)} breaks={caps.shiftBreaks} title={`${staff.find(s => s.id === pick.staff_id)?.name}　${Number(pick.date.slice(5, 7))}/${Number(pick.date.slice(8))}（${WD[dow(pick.date)]}）`}
        onPick={p => { apply([rowFrom(p, pick.staff_id, pick.date, cellOf(pick.staff_id, pick.date))]); setPick(null); }}
        onBreak={(bs, be) => { const c = cellOf(pick.staff_id, pick.date); if (!c) return; const { id: _i, store_id: _s, ...rest } = c; void _i; void _s; apply([{ ...rest, staff_id: pick.staff_id, break_start: bs, break_end: be }]); setPick(null); }}
        onClear={() => { apply([], [pick]); setPick(null); }} onClose={() => setPick(null)} />}
      {showBulk && <BulkModal staff={staff} patterns={patterns} onClose={() => setShowBulk(false)} onApply={async (map, overwrite) => {
        const rows: ShiftInput[] = [];
        for (const d of days) for (const s of staff) { const pid = map[s.id]?.[dow(d)]; const p = patterns.find(x => x.id === pid); if (!p) continue; if (!overwrite && cellOf(s.id, d)) continue; rows.push(rowFrom(p, s.id, d, cellOf(s.id, d))); }
        await apply(rows); setShowBulk(false); setMsg({ t: `曜日パターンで ${rows.length}件 入力しました`, ok: true });
      }} />}
      {showLast && <LastOrderModal store={store} menus={menus} available={caps.lastOrder} onClose={() => setShowLast(false)} onSaved={async () => { setStore(await repo.store()); setShowLast(false); if (month) setDirty(true); }} />}
      {showPatterns && <PatternEditor key={patterns.map(p => `${p.id}${p.name}${p.start_time}${p.end_time}${p.color}`).join()} patterns={patterns} onClose={() => setShowPatterns(false)} onChanged={async () => setPatterns(await repo.shiftPatterns())} />}
    </div>
  );
}

function PatternPicker({ patterns, cur, title, breaks, onPick, onBreak, onClear, onClose }: { patterns: ShiftPattern[]; cur?: Shift; title: string; breaks: boolean; onPick: (p: ShiftPattern) => void; onBreak: (start: string | null, end: string | null) => void; onClear: () => void; onClose: () => void }) {
  const [bs, setBs] = useState(cur?.break_start || "");
  const [be, setBe] = useState(cur?.break_end || "");
  const bad = !!bs && !!be && bs >= be;
  return (
    <div className="fixed inset-0 bg-black/30 z-40 flex items-center justify-center" onClick={onClose}>
      <div className="bg-white rounded-xl p-4 w-full max-w-xs" onClick={e => e.stopPropagation()}>
        <div className="font-bold mb-3">{title}</div>
        <div className="grid grid-cols-2 gap-2 mb-3">
          {patterns.map(p => <button key={p.id} onClick={() => onPick(p)} className={`rounded-lg py-2 font-bold text-sm ${cur?.pattern_id === p.id ? "ring-2 ring-offset-1 ring-stone-700" : ""}`} style={{ background: p.color, color: textOn(p.color) }}>
            {p.name}{p.kind === "work" && <div className="text-[10px] font-normal">{p.start_time}〜{p.end_time}</div>}
          </button>)}
        </div>
        {cur?.kind === "work" && (breaks ? (
          <div className="border-t pt-2 mb-3">
            <div className="lbl">休憩（この時間は受付枠IDLEを閉じます）</div>
            <div className="flex items-center gap-1">
              <input type="time" step={900} className="inp w-24" value={bs} onChange={e => setBs(e.target.value)} />〜
              <input type="time" step={900} className="inp w-24" value={be} onChange={e => setBe(e.target.value)} />
              <button className="btn text-xs" disabled={bad || (!!bs !== !!be)} onClick={() => onBreak(bs || null, be || null)}>保存</button>
            </div>
            {bad && <div className="text-xs text-rose-600 mt-1">終了は開始より後にしてください</div>}
            {cur.break_start && <button className="text-xs text-stone-500 underline mt-1" onClick={() => onBreak(null, null)}>休憩を消す</button>}
          </div>
        ) : <div className="text-[11px] text-stone-400 border-t pt-2 mb-3">休憩時間の入力は準備中（DB更新0006の後に使えます）</div>)}
        <div className="flex justify-between"><button className="btn text-rose-600" onClick={onClear}>消す</button><button className="btn" onClick={onClose}>閉じる</button></div>
      </div>
    </div>
  );
}

function BulkModal({ staff, patterns, onApply, onClose }: { staff: Staff[]; patterns: ShiftPattern[]; onApply: (map: Record<string, Record<number, string>>, overwrite: boolean) => void; onClose: () => void }) {
  const [map, setMap] = useState<Record<string, Record<number, string>>>({});
  const [overwrite, setOverwrite] = useState(true);
  return (
    <div className="fixed inset-0 bg-black/30 z-40 flex items-center justify-center p-2" onClick={onClose}>
      <div className="bg-white rounded-xl p-4 w-full max-w-2xl max-h-[92vh] overflow-auto" onClick={e => e.stopPropagation()}>
        <div className="font-bold mb-1">曜日で一括入力</div>
        <div className="text-xs text-stone-500 mb-2">曜日ごとのパターンを選ぶと、この月の同じ曜日に全部入ります。空欄の曜日は変えません。</div>
        <table className="w-full mb-3"><thead><tr><th className="th">スタッフ</th>{WD.map((w, i) => <th key={w} className={`th text-center ${i === 0 ? "text-rose-600" : i === 6 ? "text-sky-700" : ""}`}>{w}</th>)}</tr></thead>
          <tbody>{staff.map(s => <tr key={s.id}><td className="td font-semibold whitespace-nowrap">{s.name}</td>{WD.map((_, i) => <td key={i} className="td px-0.5">
            <select className="inp w-full px-0.5 text-xs" value={map[s.id]?.[i] || ""} onChange={e => setMap({ ...map, [s.id]: { ...(map[s.id] || {}), [i]: e.target.value } })}>
              <option value="">—</option>{patterns.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select></td>)}</tr>)}</tbody></table>
        <label className="inline-flex items-center gap-1 text-sm mb-3"><input type="checkbox" checked={overwrite} onChange={e => setOverwrite(e.target.checked)} />入力済みの日も上書きする</label>
        <div className="flex justify-end gap-2"><button className="btn" onClick={onClose}>やめる</button><button className="btn-primary" onClick={() => onApply(map, overwrite)}>この月に入れる</button></div>
      </div>
    </div>
  );
}

function PatternEditor({ patterns, onClose, onChanged }: { patterns: ShiftPattern[]; onClose: () => void; onChanged: () => void }) {
  const repo = getRepo();
  const [rows, setRows] = useState<Partial<ShiftPattern>[]>(patterns);
  const [err, setErr] = useState("");
  const set = (i: number, patch: Partial<ShiftPattern>) => setRows(rows.map((r, j) => j === i ? { ...r, ...patch } : r));
  async function save(r: Partial<ShiftPattern>, i: number) {
    try {
      if (!r.name) throw new Error("名前を入れてください");
      if (r.kind === "work" && (!r.start_time || !r.end_time)) throw new Error("出勤のパターンは開始・終了を入れてください");
      await repo.saveShiftPattern({ ...r, name: r.name, kind: (r.kind || "work") as ShiftKind, sort_order: r.sort_order ?? i + 1, start_time: r.kind === "work" ? r.start_time : null, end_time: r.kind === "work" ? r.end_time : null });
      setErr(""); onChanged();
    } catch (e) { setErr((e as Error).message); }
  }
  return (
    <div className="fixed inset-0 bg-black/30 z-40 flex items-center justify-center p-2" onClick={onClose}>
      <div className="bg-white rounded-xl p-4 w-full max-w-2xl max-h-[92vh] overflow-auto" onClick={e => e.stopPropagation()}>
        <div className="font-bold mb-1">勤務パターン（この店舗）</div>
        {err && <div className="text-rose-600 text-sm mb-1">{err}</div>}
        <table className="w-full mb-3"><thead><tr><th className="th">名前</th><th className="th">種類</th><th className="th">開始</th><th className="th">終了</th><th className="th">色</th><th className="th" /></tr></thead>
          <tbody>{rows.map((r, i) => <tr key={r.id || `new${i}`}>
            <td className="td"><input className="inp w-20" value={r.name || ""} onChange={e => set(i, { name: e.target.value })} /></td>
            <td className="td"><select className="inp" value={r.kind || "work"} onChange={e => set(i, { kind: e.target.value as ShiftKind })}>{(Object.keys(KIND_LABEL) as ShiftKind[]).map(k => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}</select></td>
            <td className="td"><input type="time" step={900} className="inp" disabled={(r.kind || "work") !== "work"} value={r.start_time || ""} onChange={e => set(i, { start_time: e.target.value })} /></td>
            <td className="td"><input type="time" step={900} className="inp" disabled={(r.kind || "work") !== "work"} value={r.end_time || ""} onChange={e => set(i, { end_time: e.target.value })} /></td>
            <td className="td"><input type="color" className="w-8 h-7 border rounded" value={r.color || "#888888"} onChange={e => set(i, { color: e.target.value })} /></td>
            <td className="td whitespace-nowrap"><button className="btn text-xs" onClick={() => save(r, i)}>保存</button>{r.id && <button className="btn text-xs text-rose-600 ml-1" onClick={async () => { if (confirm(`「${r.name}」を消しますか？（入力済みのシフトは残ります）`)) { await repo.deleteShiftPattern(r.id!); onChanged(); } }}>削除</button>}</td>
          </tr>)}</tbody></table>
        <div className="flex justify-between"><button className="btn" onClick={() => setRows([...rows, { name: "", kind: "work", start_time: "10:00", end_time: "19:00", color: "#888888" }])}>＋ パターンを追加</button><button className="btn" onClick={onClose}>閉じる</button></div>
      </div>
    </div>
  );
}

function LastOrderModal({ store, menus, available, onClose, onSaved }: { store: Store | null; menus: Menu[]; available: boolean; onClose: () => void; onSaved: () => void }) {
  const repo = getRepo();
  const auto = lastOrderOffset({ last_order_offset_min: null }, menus);
  const [mode, setMode] = useState<"auto" | "manual">(store?.last_order_offset_min != null ? "manual" : "auto");
  const [val, setVal] = useState(String(store?.last_order_offset_min ?? auto.min));
  const [err, setErr] = useState("");
  async function save() {
    try {
      const n = mode === "auto" ? null : Number(val);
      if (n !== null && (!Number.isFinite(n) || n < 0 || n > 600)) throw new Error("0〜600分で入れてください");
      await repo.updateStoreSettings({ last_order_offset_min: n }); onSaved();
    } catch (e) { setErr((e as Error).message); }
  }
  return (
    <div className="fixed inset-0 bg-black/30 z-40 flex items-center justify-center p-2" onClick={onClose}>
      <div className="bg-white rounded-xl p-4 w-full max-w-sm" onClick={e => e.stopPropagation()}>
        <div className="font-bold mb-1">最終受付（受付枠IDLEの閉め方）</div>
        <div className="text-xs text-stone-500 mb-3">シフト終了の何分前で受付枠を閉じるか。シフトの「確定」で並べるIDLEに使います（休憩がある日は休憩の前も同じだけ早く閉じます）。</div>
        {!available ? <div className="text-sm bg-stone-100 rounded p-2 mb-3">いまは自動（最短メニュー {auto.min}分）で動いています。上書きの設定は準備中です（DB更新0006の後に使えます）。</div> : <>
          <label className="flex items-center gap-2 text-sm mb-2"><input type="radio" checked={mode === "auto"} onChange={() => setMode("auto")} />自動：最短メニューの所要時間（{auto.menu ? `${auto.menu.name} ${auto.min}分` : "メニューなし"}）</label>
          <label className="flex items-center gap-2 text-sm mb-3"><input type="radio" checked={mode === "manual"} onChange={() => setMode("manual")} />指定：終了の <input type="number" min={0} max={600} step={15} className="inp w-20 text-right" disabled={mode !== "manual"} value={val} onChange={e => setVal(e.target.value)} /> 分前</label>
        </>}
        {err && <div className="text-sm text-rose-600 mb-2">{err}</div>}
        <div className="flex justify-end gap-2"><button className="btn" onClick={onClose}>閉じる</button>{available && <button className="btn-primary" onClick={save}>保存</button>}</div>
        <div className="text-[11px] text-stone-400 mt-2">変更後は、シフトの「確定」をもう一度押すとIDLEが作り直されます。</div>
      </div>
    </div>
  );
}
