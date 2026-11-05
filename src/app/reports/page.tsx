"use client";
// 集計（サロンアンサー参考）：期間（日・月・年・任意）× 軸（店舗・担当・メニュー・経路・新規/再来）
// 材料は期間でまとめて取得（Repo.reportBundle）し、ブラウザで集計する。DB変更なしで動く（目標だけ0006）。
import { useCallback, useEffect, useMemo, useState } from "react";
import { getRepo, todayStr, CHANNEL_LABEL, type Store, type Sale, type StoreGoal, type ID } from "@/lib/db";
import { addDays, addMonths, monthDays, localDate, WD, dow } from "@/lib/schedule";
import { makeCtx, computeKpi, projection, comparePeriods, daysOf, workAndBooked, isLive, isNewCustomer, treatMin, hasNextBooking, pct, yenR, hours, diffRate, type Ctx, type Kpi, type Period, type Scope } from "@/lib/reports";
import { getReportScope, REPORT_SCOPE_EVENT } from "@/lib/storeScope";

type Kind = "day" | "month" | "year" | "custom";
type Axis = "store" | "staff" | "menu" | "channel" | "newrep";
const KIND_LABEL: Record<Kind, string> = { day: "日次", month: "月次", year: "年次", custom: "任意期間" };
const AXIS_LABEL: Record<Axis, string> = { store: "店舗", staff: "担当", menu: "メニュー", channel: "経路", newrep: "新規・再来" };
const NEXT_OPTS = [{ v: 0, l: "会計日のうち" }, { v: 7, l: "7日以内" }, { v: 14, l: "14日以内" }, { v: 30, l: "30日以内" }];
const NEXT_KEY = "salon-app.reports-next-days";

function downloadCsv(name: string, rows: (string | number)[][]) {
  const csv = "﻿" + rows.map(r => r.map(v => { const s = String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }).join(",")).join("\r\n");
  const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" })); a.download = name; a.click(); URL.revokeObjectURL(a.href);
}
const minDate = (a: string, b: string) => (a < b ? a : b);

interface Row { key: string; label: string; sub?: string; k?: Kpi; scope?: Scope; menu?: { qty: number; amount: number; tmin: number; guests: number; kind: string }; filter: (s: Sale) => boolean }
interface Col { label: string; v: (r: Row) => string; csv?: (r: Row) => string | number; right?: boolean }

export default function ReportsPage() {
  const repo = getRepo();
  const today = todayStr();
  const [kind, setKind] = useState<Kind>("month");
  const [day, setDay] = useState(today);
  const [ym, setYm] = useState(today.slice(0, 7));
  const [year, setYear] = useState(today.slice(0, 4));
  const [cFrom, setCFrom] = useState(addDays(today, -29));
  const [cTo, setCTo] = useState(today);
  const [axis, setAxis] = useState<Axis>("staff");
  const [nextDays, setNextDays] = useState(0);
  const [scopeAll, setScopeAll] = useState(false);
  const [stores, setStores] = useState<Store[]>([]);
  const [cur, setCur] = useState<Store | null>(null);
  const [data, setData] = useState<{ ctx: Ctx; cmp: { label: string; p: Period; k: Kpi }[]; goals: StoreGoal[] | null } | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [drill, setDrill] = useState<Row | null>(null);
  const [goalInput, setGoalInput] = useState("");
  const [goalMsg, setGoalMsg] = useState("");

  useEffect(() => {
    void Promise.resolve().then(() => { try { const n = Number(localStorage.getItem(NEXT_KEY)); if ([0, 7, 14, 30].includes(n)) setNextDays(n); } catch {} });
    repo.store().then(setCur).catch(() => {}); repo.stores().then(setStores).catch(() => {});
    const sync = () => setScopeAll(getReportScope() === "all"); void Promise.resolve().then(sync);
    window.addEventListener(REPORT_SCOPE_EVENT, sync); return () => window.removeEventListener(REPORT_SCOPE_EVENT, sync);
  }, [repo]);
  const all = scopeAll && stores.length > 1;
  const storeIds = useMemo(() => (all ? stores.map(s => s.id) : cur ? [cur.id] : []), [all, stores, cur]);

  const period: Period = useMemo(() => {
    if (kind === "day") return { from: day, to: addDays(day, 1) };
    if (kind === "month") { const d = monthDays(ym); return { from: d[0], to: addDays(d[d.length - 1], 1) }; }
    if (kind === "year") return { from: `${year}-01-01`, to: `${Number(year) + 1}-01-01` };
    return cFrom <= cTo ? { from: cFrom, to: addDays(cTo, 1) } : { from: cTo, to: addDays(cFrom, 1) };
  }, [kind, day, ym, year, cFrom, cTo]);
  const cp = useMemo(() => comparePeriods(kind, period, today), [kind, period, today]);

  const load = useCallback(async () => {
    if (!storeIds.length) return;
    setLoading(true); setErr("");
    try {
      // 再来率（90日）・次回予約の判定用に、期間の後ろも取る
      const salesTo = minDate(addDays(period.to, 91), addDays(today, 1)) > period.to ? minDate(addDays(period.to, 91), addDays(today, 1)) : period.to;
      const bundle = await repo.reportBundle(storeIds, period.from, salesTo, addDays(period.to, 181));
      const ctx = makeCtx(bundle, today, nextDays);
      const cmp = await Promise.all(cp.list.map(async c => {
        const b2 = await repo.reportBundle(storeIds, c.p.from, c.p.to, addDays(c.p.to, 31));
        return { label: c.label, p: c.p, k: computeKpi(makeCtx(b2, today, nextDays), c.p) };
      }));
      const goals = await repo.goals(storeIds, period.from.slice(0, 7), addDays(period.to, -1).slice(0, 7)).catch(() => null);
      setData({ ctx, cmp, goals });
    } catch (e) { setErr((e as Error).message); }
    finally { setLoading(false); }
  }, [repo, storeIds, period, cp, today, nextDays]);
  useEffect(() => { void Promise.resolve().then(load); }, [load]);

  const ctx = data?.ctx;
  const k = useMemo(() => (ctx ? computeKpi(ctx, period) : null), [ctx, period]);
  const proj = useMemo(() => (ctx && k ? projection(ctx, period, k.total) : null), [ctx, k, period]);
  const goalSum = data?.goals ? data.goals.reduce((a, g) => a + g.target_sales, 0) : null;
  const goalAvailable = data?.goals !== null && data?.goals !== undefined;
  const goalTarget = goalSum && (kind === "month" || kind === "year") ? goalSum : null;
  useEffect(() => { if (kind === "month" && data?.goals && !all) { const g = data.goals.find(x => x.ym === ym); void Promise.resolve().then(() => setGoalInput(g ? String(g.target_sales) : "")); } }, [data, kind, ym, all]);

  // ---- 軸ごとの行 ----
  const effAxis: Axis = axis === "store" && !all ? "staff" : axis;
  const rows: Row[] = useMemo(() => RowsCalc(ctx, effAxis, period, all), [ctx, effAxis, period, all]);

  const cols: Col[] = useMemo(() => {
    const K = (f: (k: Kpi) => string, c?: (k: Kpi) => string | number): Pick<Col, "v" | "csv"> => ({ v: r => (r.k ? f(r.k) : "—"), csv: r => (r.k ? (c ? c(r.k) : f(r.k)) : "") });
    const R = (x: number | null) => (x === null ? "" : Math.round(x * 1000) / 10);
    const Y = (x: number | null) => (x === null ? "" : Math.round(x));
    if (effAxis === "menu") return [
      { label: "区分", v: r => r.menu!.kind, csv: r => r.menu!.kind },
      { label: "数量", right: true, v: r => String(r.menu!.qty), csv: r => r.menu!.qty },
      { label: "売上", right: true, v: r => yenR(r.menu!.amount), csv: r => r.menu!.amount },
      { label: "平均単価", right: true, v: r => yenR(r.menu!.qty ? r.menu!.amount / r.menu!.qty : null), csv: r => Y(r.menu!.qty ? r.menu!.amount / r.menu!.qty : null) },
      { label: "施術時間", right: true, v: r => (r.menu!.tmin ? hours(r.menu!.tmin) : "—"), csv: r => (r.menu!.tmin / 60).toFixed(1) },
      { label: "時間単価", right: true, v: r => yenR(r.menu!.tmin ? r.menu!.amount / (r.menu!.tmin / 60) : null), csv: r => Y(r.menu!.tmin ? r.menu!.amount / (r.menu!.tmin / 60) : null) },
    ];
    const base: Col[] = [
      { label: "売上", right: true, ...K(k => yenR(k.total), k => k.total) },
      { label: "客数", right: true, ...K(k => String(k.guests), k => k.guests) },
    ];
    if (effAxis === "newrep") return [...base,
      { label: "人数", right: true, ...K(k => String(k.newGuests + k.repeatGuests), k => k.newGuests + k.repeatGuests) },
      { label: "客単価", right: true, ...K(k => yenR(k.unit), k => Y(k.unit)) },
      { label: "店販購入率", right: true, ...K(k => pct(k.productBuyRate), k => R(k.productBuyRate)) },
      { label: "次回予約率", right: true, ...K(k => pct(k.nextRate), k => R(k.nextRate)) },
      { label: "再来率30日", right: true, ...K(k => pct(k.retAll[30].rate), k => R(k.retAll[30].rate)) },
      { label: "60日", right: true, ...K(k => pct(k.retAll[60].rate), k => R(k.retAll[60].rate)) },
      { label: "90日", right: true, ...K(k => pct(k.retAll[90].rate), k => R(k.retAll[90].rate)) },
    ];
    if (effAxis === "channel") return [...base,
      { label: "新規", right: true, ...K(k => String(k.newGuests), k => k.newGuests) },
      { label: "客単価", right: true, ...K(k => yenR(k.unit), k => Y(k.unit)) },
      { label: "次回予約率", right: true, ...K(k => pct(k.nextRate), k => R(k.nextRate)) },
      { label: "予約数", right: true, ...K(k => (k.bookingCnt ? String(k.bookingCnt) : "—"), k => k.bookingCnt) },
      { label: "キャンセル率", right: true, ...K(k => pct(k.cancelRate), k => R(k.cancelRate)) },
    ];
    return [...base,
      { label: "新規", right: true, ...K(k => String(k.newGuests), k => k.newGuests) },
      { label: "客単価", right: true, ...K(k => yenR(k.unit), k => Y(k.unit)) },
      { label: "技術", right: true, ...K(k => yenR(k.tech), k => k.tech) },
      { label: "店販", right: true, ...K(k => yenR(k.product), k => k.product) },
      ...(effAxis === "store" ? [{ label: "1名あたり", right: true, ...K(k => yenR(k.perStaff), k => Y(k.perStaff)) }] : []),
      { label: "指名率", right: true, ...K(k => pct(k.nominatedRate), k => R(k.nominatedRate)) },
      { label: "次回予約率", right: true, ...K(k => pct(k.nextRate), k => R(k.nextRate)) },
      { label: "稼働率", right: true, ...K(k => pct(k.occupancy), k => R(k.occupancy)) },
      { label: "時間単価", right: true, ...K(k => yenR(k.hourly), k => Y(k.hourly)) },
      { label: "出勤", right: true, ...K(k => (k.workMin ? hours(k.workMin) : "—"), k => (k.workMin / 60).toFixed(1)) },
    ];
  }, [effAxis]);

  // ---- グラフ用の系列（日別。年次は月別、日次は1時間ごと） ----
  const series = useMemo(() => {
    if (!ctx) return [];
    const b = ctx.b;
    if (kind === "year") return Array.from({ length: 12 }, (_, i) => {
      const m = `${year}-${String(i + 1).padStart(2, "0")}`; const d = monthDays(m); const p = { from: d[0], to: addDays(d[d.length - 1], 1) };
      const sales = b.sales.filter(s => localDate(s.sold_at) >= p.from && localDate(s.sold_at) < p.to);
      const wb = workAndBooked(b.shifts, b.bookings, p);
      return { key: m, label: `${i + 1}月`, sales: sales.reduce((a, s) => a + s.total, 0), guests: sales.filter(isLive).length, occ: wb.workMin ? wb.bookedMin / wb.workMin : null, weekend: false };
    });
    if (kind === "day") {
      const sales = b.sales.filter(s => localDate(s.sold_at) === day);
      const work = b.shifts.filter(s => s.date === day && s.kind === "work" && s.start_time && s.end_time);
      const bks = b.bookings.filter(x => localDate(x.start_at) === day && x.status !== "block" && x.status !== "cancelled" && x.status !== "noshow");
      const tm = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
      const hs = Array.from({ length: 14 }, (_, i) => i + 8);
      return hs.map(h => {
        const a = h * 60, z = a + 60; let wm = 0, bm = 0;
        for (const w of work) { const s = Math.max(a, tm(w.start_time!)), e = Math.min(z, tm(w.end_time!)); if (e > s) wm += e - s;
          for (const x of bks.filter(x => x.staff_id === w.staff_id)) { const st = new Date(x.start_at), en = new Date(x.end_at); const s2 = Math.max(s, st.getHours() * 60 + st.getMinutes()), e2 = Math.min(e, en.getHours() * 60 + en.getMinutes()); if (e2 > s2) bm += e2 - s2; } }
        const ss = sales.filter(s => new Date(s.sold_at).getHours() === h);
        return { key: String(h), label: `${h}時`, sales: ss.reduce((x, s) => x + s.total, 0), guests: ss.filter(isLive).length, occ: wm ? bm / wm : null, weekend: false };
      });
    }
    return daysOf(period).map(d => {
      const sales = b.sales.filter(s => localDate(s.sold_at) === d);
      const wb = workAndBooked(b.shifts, b.bookings, { from: d, to: addDays(d, 1) });
      return { key: d, label: `${Number(d.slice(5, 7))}/${Number(d.slice(8))}`, sales: sales.reduce((a, s) => a + s.total, 0), guests: sales.filter(isLive).length, occ: wb.workMin ? wb.bookedMin / wb.workMin : null, weekend: dow(d) === 0 || dow(d) === 6 };
    });
  }, [ctx, kind, year, day, period]);

  async function saveGoal() {
    if (!cur) return;
    const v = goalInput.trim() === "" ? null : Number(goalInput.replace(/[,¥]/g, ""));
    if (v !== null && (!Number.isFinite(v) || v < 0)) { setGoalMsg("金額を数字で入れてください"); return; }
    try { await repo.saveGoal(cur.id, ym, v); setGoalMsg("保存しました"); await load(); } catch (e) { setGoalMsg((e as Error).message); }
  }

  const scopeName = all ? `全店（${stores.length}店舗）` : cur?.name || "";
  const periodLabel = kind === "day" ? `${day.replace(/-/g, "/")}（${WD[dow(day)]}）` : kind === "month" ? `${ym.replace("-", "年")}月` : kind === "year" ? `${year}年` : `${period.from.replace(/-/g, "/")}〜${addDays(period.to, -1).replace(/-/g, "/")}`;
  const tableCsv = () => [["軸", AXIS_LABEL[effAxis]], ["期間", periodLabel], ["対象", scopeName], [], [AXIS_LABEL[effAxis], "補足", ...cols.map(c => c.label)], ...rows.map(r => [r.label, r.sub || "", ...cols.map(c => (c.csv ? c.csv(r) : c.v(r)))])];
  function csvAll() {
    if (!k) return;
    const out: (string | number)[][] = [["集計", scopeName, periodLabel], [], ["指標", "値"], ...kpiList(k).map(([a, b]) => [a, b])];
    const axes: Axis[] = all ? ["store", "staff", "menu", "channel", "newrep"] : ["staff", "menu", "channel", "newrep"];
    for (const ax of axes) {
      const r = ax === effAxis ? rows : RowsCalc(ctx, ax, period, all); const c = ColsCalc(ax);
      out.push([], [`■ ${AXIS_LABEL[ax]}別`], [AXIS_LABEL[ax], "補足", ...c.map(x => x.label)], ...r.map(x => [x.label, x.sub || "", ...c.map(cc => (cc.csv ? cc.csv(x) : cc.v(x)))]));
    }
    out.push([], [`■ ${kind === "year" ? "月別" : kind === "day" ? "時間帯別" : "日別"}`], ["区切り", "売上", "客数", "稼働率(%)"], ...series.map(s => [s.key, s.sales, s.guests, s.occ === null ? "" : Math.round(s.occ * 1000) / 10]));
    downloadCsv(`集計_${scopeName}_${periodLabel}.csv`, out);
  }

  return (
    <div className="max-w-6xl">
      {/* 期間・対象 */}
      <div className="flex flex-wrap items-center gap-2 mb-2">
        <h1 className="text-xl font-bold mr-1">集計</h1>
        <div className="inline-flex border rounded overflow-hidden" role="tablist">
          {(Object.keys(KIND_LABEL) as Kind[]).map(x => <button key={x} role="tab" aria-selected={kind === x} onClick={() => setKind(x)} className={`px-3 py-1.5 text-sm border-r last:border-r-0 ${kind === x ? "bg-[#2f6b4f] text-white font-semibold" : "bg-white hover:bg-stone-100"}`}>{KIND_LABEL[x]}</button>)}
        </div>
        {kind === "day" && <div className="flex gap-1"><button className="btn" onClick={() => setDay(addDays(day, -1))}>前日</button><input type="date" className="inp" value={day} onChange={e => e.target.value && setDay(e.target.value)} /><button className="btn" onClick={() => setDay(addDays(day, 1))}>次日</button></div>}
        {kind === "month" && <div className="flex gap-1"><button className="btn" onClick={() => setYm(addMonths(ym, -1))}>前月</button><input type="month" className="inp" value={ym} onChange={e => e.target.value && setYm(e.target.value)} /><button className="btn" onClick={() => setYm(addMonths(ym, 1))}>次月</button></div>}
        {kind === "year" && <div className="flex gap-1"><button className="btn" onClick={() => setYear(String(Number(year) - 1))}>前年</button><input type="number" className="inp w-24" value={year} onChange={e => setYear(e.target.value)} /><button className="btn" onClick={() => setYear(String(Number(year) + 1))}>次年</button></div>}
        {kind === "custom" && <div className="flex items-center gap-1"><input type="date" className="inp" value={cFrom} onChange={e => setCFrom(e.target.value)} />〜<input type="date" className="inp" value={cTo} onChange={e => setCTo(e.target.value)} /></div>}
        <span className="text-sm text-stone-600">対象：<b>{scopeName}</b>{stores.length > 1 && <span className="text-xs text-stone-400 ml-1">（上の店舗ボタンで「全店」も選べます）</span>}</span>
        <div className="ml-auto flex gap-1">
          <button className="btn" onClick={() => downloadCsv(`集計_${AXIS_LABEL[effAxis]}_${scopeName}_${periodLabel}.csv`, tableCsv())} disabled={!rows.length}>この表をCSV</button>
          <button className="btn" onClick={csvAll} disabled={!k}>全表CSV</button>
        </div>
      </div>
      {err && <div className="mb-2 text-sm px-3 py-2 rounded bg-rose-50 text-rose-700 border border-rose-200">読み込めませんでした：{err}</div>}
      {loading && <div className="text-xs text-stone-500 mb-1">読み込み中…</div>}

      {k && <>
        {/* 上段：KPIカード */}
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-2 mb-2">
          <Card title={`売上（${periodLabel}${cp.partial ? "・今日まで" : ""}）`} value={yenR(k.total)} lines={[...data!.cmp.map(c => cmpLine(c.label, k.total, c.k.total)), ...(goalTarget ? [`目標比 ${pct(k.total / goalTarget, 0)}（目標 ${yenR(goalTarget)}）`] : [])]} />
          <Card title="着地予測" value={proj ? yenR(proj.value) : "—"} accent
            lines={proj ? [`1営業日 ${yenR(proj.perDay)}×残り${proj.remainBiz}日${proj.estimated ? "（シフト未入力の日は見積り）" : ""}`, ...(goalTarget ? [`目標達成率 ${pct(proj.value / goalTarget, 0)}`] : []), `予約済みの見込み ${yenR(k.futureBooked)}`] : ["期間が進行中のときに出ます"]} />
          <Card title="客数" value={`${k.guests}人`} lines={[`人数：新規 ${k.newGuests}／再来 ${k.repeatGuests}${k.unregistered ? `／未登録 ${k.unregistered}` : ""}`, ...data!.cmp.map(c => cmpLine(c.label, k.guests, c.k.guests))]} />
          <Card title="新規" value={`${k.newGuests}人`} lines={[`新規比率 ${pct(k.guests ? k.newGuests / k.guests : null, 0)}`, ...data!.cmp.map(c => cmpLine(c.label, k.newGuests, c.k.newGuests))]} />
          <Card title={`次回予約率（${NEXT_OPTS.find(o => o.v === nextDays)?.l}）`} value={pct(k.nextRate)} lines={[`${k.nextNum}/${k.nextDen}人`, ...data!.cmp.map(c => `${c.label} ${pct(c.k.nextRate)}`)]} />
          <Card title="稼働率" value={pct(k.occupancy)} lines={[`予約 ${hours(k.bookedMin)}／出勤 ${hours(k.workMin)}`, ...data!.cmp.map(c => `${c.label} ${pct(c.k.occupancy)}`)]} />
        </div>

        {/* 目標 */}
        {kind === "month" && (
          <div className="flex flex-wrap items-center gap-2 text-sm mb-2">
            {!goalAvailable ? <span className="text-xs text-stone-500 bg-stone-100 rounded px-2 py-1">目標売上の入力は準備中です（DB更新0006の後に使えます）</span>
              : all ? <span className="text-xs text-stone-600">目標（各店の合計）：{goalSum ? yenR(goalSum) : "未入力"}　※目標の入力は店舗ごとの画面で</span>
              : <>
                <span className="text-stone-600">{ym.replace("-", "年")}月の目標売上</span>
                <input className="inp w-32 text-right" inputMode="numeric" placeholder="例 1000000" value={goalInput} onChange={e => { setGoalInput(e.target.value); setGoalMsg(""); }} />
                <button className="btn" onClick={saveGoal}>保存</button>
                {goalMsg && <span className="text-xs text-emerald-700">{goalMsg}</span>}
              </>}
          </div>
        )}

        {/* 指標の一覧 */}
        <div className="card mb-2">
          <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-x-4 gap-y-1.5 text-sm">
            {kpiList(k).slice(0, 24).map(([a, b]) => <div key={a} className="flex flex-col"><span className="text-[11px] text-stone-500">{a}</span><span className="font-semibold tabular-nums">{b}</span></div>)}
          </div>
        </div>

        {/* 中段：グラフ */}
        <Charts series={series} kind={kind} />

        {/* 下段：表 */}
        <div className="card">
          <div className="flex flex-wrap items-center gap-2 mb-2">
            <div className="inline-flex border rounded overflow-hidden" role="tablist">
              {(Object.keys(AXIS_LABEL) as Axis[]).filter(a => a !== "store" || all).map(a => <button key={a} role="tab" aria-selected={effAxis === a} onClick={() => setAxis(a)} className={`px-3 py-1.5 text-sm border-r last:border-r-0 ${effAxis === a ? "bg-[#2f6b4f] text-white font-semibold" : "bg-white hover:bg-stone-100"}`}>{AXIS_LABEL[a]}</button>)}
            </div>
            <label className="text-xs text-stone-600 flex items-center gap-1">次回予約の判定
              <select className="inp text-xs py-1" value={nextDays} onChange={e => { const n = Number(e.target.value); setNextDays(n); try { localStorage.setItem(NEXT_KEY, String(n)); } catch {} }}>{NEXT_OPTS.map(o => <option key={o.v} value={o.v}>{o.l}</option>)}</select>
            </label>
            <span className="text-xs text-stone-400 ml-auto">行を押すと伝票の明細</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px]">
              <thead><tr><th className="th">{AXIS_LABEL[effAxis]}</th>{cols.map(c => <th key={c.label} className={`th whitespace-nowrap ${c.right ? "text-right" : ""}`}>{c.label}</th>)}</tr></thead>
              <tbody>
                {rows.map(r => <tr key={r.key} className="cursor-pointer hover:bg-emerald-50" onClick={() => setDrill(r)}>
                  <td className="td"><div className="font-semibold">{r.label}</div>{r.sub && <div className="text-[10px] text-stone-500">{r.sub}</div>}</td>
                  {cols.map(c => <td key={c.label} className={`td tabular-nums whitespace-nowrap ${c.right ? "text-right" : ""}`}>{c.v(r)}</td>)}
                </tr>)}
                {!rows.length && <tr><td className="td text-stone-400" colSpan={cols.length + 1}>この期間のデータはありません</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
        <Notes nextDays={nextDays} />
      </>}

      {drill && ctx && <Drill row={drill} ctx={ctx} period={period} all={all} onClose={() => setDrill(null)} />}
    </div>
  );
}

// 表の計算（全表CSVで、表示中でない軸を作るのに使う）
function RowsCalc(ctx: Ctx | undefined, ax: Axis, period: Period, all: boolean): Row[] {
  if (!ctx) return [];
  const b = ctx.b; const inPer = (s: Sale) => localDate(s.sold_at) >= period.from && localDate(s.sold_at) < period.to;
  const mk = (key: string, label: string, scope: Scope, sub?: string): Row => ({ key, label, sub, scope, k: computeKpi(ctx, period, scope), filter: scope.sale || (() => true) });
  const byTotal = (x: Row, y: Row) => (y.k?.total || 0) - (x.k?.total || 0);
  if (ax === "store") return b.stores.map(st => mk(st.id, st.name, { sale: s => s.store_id === st.id, booking: x => x.store_id === st.id, shift: x => x.store_id === st.id }, st.company_name || ""));
  if (ax === "staff") {
    const ids = new Set<ID>(); b.sales.filter(s => inPer(s) && s.main_staff_id).forEach(s => ids.add(s.main_staff_id!));
    b.shifts.filter(s => s.kind === "work" && s.date >= period.from && s.date < period.to && s.staff_id).forEach(s => ids.add(s.staff_id!));
    const out = b.staff.filter(s => ids.has(s.id)).map(st => mk(st.id, st.name, { sale: s => s.main_staff_id === st.id, booking: x => x.staff_id === st.id, shift: x => x.staff_id === st.id },
      all ? b.stores.filter(x => b.shifts.some(sh => sh.staff_id === st.id && sh.store_id === x.id) || b.sales.some(sa => sa.main_staff_id === st.id && sa.store_id === x.id)).map(x => x.name).join("・") : undefined));
    if (b.sales.some(s => inPer(s) && !s.main_staff_id)) out.push(mk("none", "担当なし", { sale: s => !s.main_staff_id, booking: x => !x.staff_id, shift: null }));
    return out.sort(byTotal);
  }
  if (ax === "channel") {
    const chOf = (s: Sale) => (s.booking_id ? ctx.bookingById.get(s.booking_id)?.channel : undefined) || "none";
    const keys = new Set<string>(); b.sales.filter(inPer).forEach(s => keys.add(chOf(s)));
    b.bookings.filter(x => x.status !== "block" && localDate(x.start_at) >= period.from && localDate(x.start_at) < period.to).forEach(x => keys.add(x.channel));
    return [...keys].map(c => mk(c, c === "none" ? "予約なし（直接会計）" : CHANNEL_LABEL[c] || c, { sale: s => chOf(s) === c, booking: c === "none" ? null : x => x.channel === c, shift: null })).sort(byTotal);
  }
  if (ax === "newrep") {
    const isNew = (s: Sale) => !!s.customer_id && isNewCustomer(ctx, s.store_id, s.customer_id, period);
    return [mk("new", "新規", { sale: isNew, booking: null, shift: null }), mk("rep", "再来", { sale: s => !!s.customer_id && !isNew(s), booking: null, shift: null }), mk("unreg", "顧客未登録", { sale: s => !s.customer_id, booking: null, shift: null })];
  }
  // メニュー（明細ベース）。店販も商品別に出す
  const keyOf = (l: Sale["lines"][number]) => l.menu_id || l.product_id || `name:${l.name}`;
  const map = new Map<string, Row>();
  for (const s of b.sales.filter(inPer)) for (const l of s.lines) {
    const key = keyOf(l); let r = map.get(key);
    if (!r) { const kl = l.kind === "product" ? "店販" : l.kind === "option" ? "オプション" : "技術"; const st = all ? b.stores.find(x => x.id === s.store_id)?.name : undefined;
      r = { key, label: l.name, sub: [kl, st].filter(Boolean).join("・"), menu: { qty: 0, amount: 0, tmin: 0, guests: 0, kind: kl }, filter: x => x.lines.some(y => keyOf(y) === key) }; map.set(key, r); }
    r.menu!.qty += l.qty; r.menu!.amount += l.amount; if (l.menu_id) r.menu!.tmin += (ctx.menuById.get(l.menu_id)?.duration_min || 0) * l.qty;
  }
  return [...map.values()].sort((x, y) => y.menu!.amount - x.menu!.amount);
}
function ColsCalc(ax: Axis): Col[] {
  const R = (x: number | null) => (x === null ? "" : Math.round(x * 1000) / 10);
  const Y = (x: number | null) => (x === null ? "" : Math.round(x));
  const c = (label: string, f: (k: Kpi) => string | number): Col => ({ label, v: r => (r.k ? String(f(r.k)) : ""), csv: r => (r.k ? f(r.k) : "") });
  if (ax === "menu") return [
    { label: "区分", v: r => r.menu!.kind }, { label: "数量", v: r => String(r.menu!.qty), csv: r => r.menu!.qty }, { label: "売上", v: r => String(r.menu!.amount), csv: r => r.menu!.amount },
    { label: "平均単価", v: r => String(Y(r.menu!.qty ? r.menu!.amount / r.menu!.qty : null)) }, { label: "施術時間(h)", v: r => (r.menu!.tmin / 60).toFixed(1) },
    { label: "時間単価", v: r => String(Y(r.menu!.tmin ? r.menu!.amount / (r.menu!.tmin / 60) : null)) },
  ];
  const base = [c("売上", k => k.total), c("客数", k => k.guests), c("新規", k => k.newGuests), c("客単価", k => Y(k.unit))];
  if (ax === "newrep") return [c("売上", k => k.total), c("客数", k => k.guests), c("人数", k => k.newGuests + k.repeatGuests), c("客単価", k => Y(k.unit)), c("次回予約率(%)", k => R(k.nextRate)), c("再来率30日(%)", k => R(k.retAll[30].rate)), c("再来率60日(%)", k => R(k.retAll[60].rate)), c("再来率90日(%)", k => R(k.retAll[90].rate))];
  if (ax === "channel") return [...base, c("次回予約率(%)", k => R(k.nextRate)), c("予約数", k => k.bookingCnt), c("キャンセル率(%)", k => R(k.cancelRate))];
  return [...base, c("技術", k => k.tech), c("店販", k => k.product), c("1名あたり", k => Y(k.perStaff)), c("指名率(%)", k => R(k.nominatedRate)), c("次回予約率(%)", k => R(k.nextRate)), c("稼働率(%)", k => R(k.occupancy)), c("時間単価", k => Y(k.hourly)), c("出勤(h)", k => (k.workMin / 60).toFixed(1))];
}

function cmpLine(label: string, cur: number, prev: number) { const d = diffRate(cur, prev); return `${label} ${d === null ? "—" : `${d >= 0 ? "+" : ""}${(d * 100).toFixed(1)}%`}`; }

function kpiList(k: Kpi): [string, string][] {
  return [
    ["総売上", yenR(k.total)], ["技術売上", yenR(k.tech)], ["店販売上", yenR(k.product)], ["値引", yenR(k.discount)],
    ["赤伝", `${k.reversalCnt}件 ${yenR(k.reversalAmt)}`], ["客数", `${k.guests}人`], ["新規", `${k.newGuests}人`], ["再来", `${k.repeatGuests}人`],
    ["客単価", yenR(k.unit)], ["技術単価", yenR(k.techUnit)], ["店販単価", yenR(k.productUnit)], ["時間単価", yenR(k.hourly)],
    ["稼働率", pct(k.occupancy)], ["スタッフ1名あたり", yenR(k.perStaff)], ["出勤スタッフ", `${k.staffCount}人`], ["施術時間", hours(k.treatMin)],
    ["次回予約率", pct(k.nextRate)], ["指名率", pct(k.nominatedRate)], ["キャンセル率", `${pct(k.cancelRate)}（無断 ${pct(k.noshowRate)}）`], ["店販購入率", pct(k.productBuyRate)],
    ["新規再来率 30日", rr(k.ret[30])], ["新規再来率 60日", rr(k.ret[60])], ["新規再来率 90日", rr(k.ret[90])], ["再来率(全体) 90日", rr(k.retAll[90])],
  ];
}
const rr = (x: { rate: number | null; num: number; den: number }) => (x.rate === null ? "—（判定待ち）" : `${pct(x.rate, 0)}（${x.num}/${x.den}）`);

function Card({ title, value, lines, accent }: { title: string; value: string; lines: string[]; accent?: boolean }) {
  return (
    <div className={`card ${accent ? "border-[#2f6b4f] border-2" : ""}`}>
      <div className="text-[11px] text-stone-500 leading-tight">{title}</div>
      <div className="text-xl font-bold tabular-nums my-0.5">{value}</div>
      {lines.map((l, i) => <div key={i} className="text-[11px] text-stone-600 leading-snug">{l}</div>)}
    </div>
  );
}

// ---- グラフ（自前SVG）。軸が違う2つの値は1枚に重ねず、上下2段で同じ横軸に揃える ----
type Pt = { key: string; label: string; sales: number; guests: number; occ: number | null; weekend: boolean };
function Charts({ series, kind }: { series: Pt[]; kind: Kind }) {
  const [hi, setHi] = useState<number | null>(null);
  if (!series.length) return null;
  const W = 1000, PL = 56, PR = 12, H1 = 170, H2 = 90, PT = 10;
  const n = series.length; const bw = (W - PL - PR) / n;
  const maxS = Math.max(1, ...series.map(s => s.sales));
  const nice = (v: number) => { const p = Math.pow(10, Math.floor(Math.log10(v))); const m = v / p; return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p; };
  const top = nice(maxS);
  const y1 = (v: number) => PT + (H1 - PT - 18) * (1 - v / top);
  const y2 = (v: number) => 8 + (H2 - 26) * (1 - v);
  const x = (i: number) => PL + bw * i + bw / 2;
  const every = Math.ceil(n / 16);
  const fmt = (v: number) => (v >= 10000 ? `${Math.round(v / 10000)}万` : v.toLocaleString());
  const occPts = series.map((s, i) => (s.occ === null ? null : `${x(i)},${y2(Math.min(1, s.occ))}`));
  const segs: string[][] = []; let curSeg: string[] = [];
  occPts.forEach(p => { if (p) curSeg.push(p); else if (curSeg.length) { segs.push(curSeg); curSeg = []; } }); if (curSeg.length) segs.push(curSeg);
  const h = hi !== null ? series[hi] : null;
  const unit = kind === "year" ? "月別" : kind === "day" ? "時間帯別" : "日別";
  return (
    <div className="card mb-2 relative">
      <div className="flex items-baseline gap-3 mb-1"><span className="font-bold text-sm">{unit}の売上</span><span className="text-[11px] text-stone-500">下段：稼働率（予約時間÷出勤時間）</span></div>
      <svg viewBox={`0 0 ${W} ${H1 + H2}`} className="w-full h-auto select-none" onMouseLeave={() => setHi(null)} role="img" aria-label={`${unit}の売上と稼働率`}>
        {/* 上段：売上 */}
        {[0, 0.5, 1].map(f => <g key={f}><line x1={PL} x2={W - PR} y1={y1(top * f)} y2={y1(top * f)} stroke="#e7e5e4" strokeWidth={1} /><text x={PL - 6} y={y1(top * f) + 4} fontSize={11} textAnchor="end" fill="#78716c">{fmt(top * f)}</text></g>)}
        {series.map((s, i) => { const bh = Math.max(0, y1(0) - y1(s.sales)); const wdt = Math.max(2, bw - Math.min(6, bw * 0.25)); return (
          <rect key={s.key} x={x(i) - wdt / 2} y={y1(s.sales)} width={wdt} height={bh} rx={Math.min(4, wdt / 2)} fill={hi === i ? "#1f4d38" : "#2f6b4f"} opacity={hi === null || hi === i ? 1 : 0.55} />); })}
        <line x1={PL} x2={W - PR} y1={y1(0)} y2={y1(0)} stroke="#a8a29e" strokeWidth={1} />
        {series.map((s, i) => i % every === 0 && <text key={s.key} x={x(i)} y={H1 - 4} fontSize={11} textAnchor="middle" fill={s.weekend ? "#be123c" : "#57534e"}>{s.label}</text>)}
        {/* 下段：稼働率 */}
        <g transform={`translate(0, ${H1})`}>
          {[0, 0.5, 1].map(f => <g key={f}><line x1={PL} x2={W - PR} y1={y2(f)} y2={y2(f)} stroke="#e7e5e4" strokeWidth={1} /><text x={PL - 6} y={y2(f) + 4} fontSize={11} textAnchor="end" fill="#78716c">{Math.round(f * 100)}%</text></g>)}
          {segs.map((sg, i) => <polyline key={i} points={sg.join(" ")} fill="none" stroke="#b45309" strokeWidth={2} strokeLinejoin="round" />)}
          {series.map((s, i) => s.occ !== null && <circle key={s.key} cx={x(i)} cy={y2(Math.min(1, s.occ))} r={hi === i ? 5 : 3} fill="#b45309" stroke="#fff" strokeWidth={2} />)}
        </g>
        {hi !== null && <line x1={x(hi)} x2={x(hi)} y1={PT} y2={H1 + H2 - 18} stroke="#57534e" strokeDasharray="3 3" strokeWidth={1} />}
        {/* ホバー用の当たり判定（棒より広い） */}
        {series.map((s, i) => <rect key={`h${s.key}`} x={PL + bw * i} y={0} width={bw} height={H1 + H2} fill="transparent" onMouseEnter={() => setHi(i)} onTouchStart={() => setHi(i)} />)}
      </svg>
      {h && hi !== null && (
        <div className="pointer-events-none absolute top-8 bg-white border shadow rounded px-2 py-1 text-xs" style={{ left: `calc(${((x(hi)) / W) * 100}% ${hi > n / 2 ? "- 150px" : "+ 8px"})` }}>
          <div className="font-semibold">{h.label}</div>
          <div>売上 <b className="tabular-nums">¥{h.sales.toLocaleString()}</b></div>
          <div>客数 {h.guests}人</div>
          <div>稼働率 {h.occ === null ? "—（シフトなし）" : `${Math.round(h.occ * 100)}%`}</div>
        </div>
      )}
    </div>
  );
}

function Notes({ nextDays }: { nextDays: number }) {
  return (
    <div className="text-[11px] text-stone-500 mt-2 leading-relaxed">
      <div>※数字はこのアプリに入れた会計・予約・シフトだけ（サロンボード側の数字は含みません）。売上は税込。赤伝は元の伝票と相殺（客数からも除く）。</div>
      <div>・<b>次回予約率</b>＝会計したお客様のうち、来店当日〜会計日{nextDays ? `から${nextDays}日後` : "のうち"}までに「次の予約（会計より後の日時）」が台帳に入った人の割合（予約を入れた日時で判定。後でキャンセルされた予約も含む）。</div>
      <div>・<b>稼働率</b>＝シフトの出勤時間（休憩を除く）のうち、予約が入っている時間の割合。<b>時間単価</b>＝売上÷施術時間（予約の長さ。予約が無い会計はメニューの所要時間）。</div>
      <div>・<b>新規</b>＝この店舗での初来店（過去の全会計で判定）がこの期間の人。<b>再来率</b>＝期間内の来店から30/60/90日以内にもう一度会計した人の割合（まだ日数がたっていない人は分母から除く）。</div>
      <div>・<b>着地予測</b>＝実績＋（実績÷経過した営業日）×残りの営業日。営業日はシフトの出勤日（未入力の日はこれまでの営業日の割合で見積り）。比較は進行中の期間なら同じ日まで。</div>
    </div>
  );
}

function Drill({ row, ctx, period, all, onClose }: { row: Row; ctx: Ctx; period: Period; all: boolean; onClose: () => void }) {
  const b = ctx.b;
  const list = b.sales.filter(s => localDate(s.sold_at) >= period.from && localDate(s.sold_at) < period.to && row.filter(s)).sort((x, y) => x.sold_at.localeCompare(y.sold_at));
  const cname = (id?: string | null) => (id ? b.customers.find(c => c.id === id)?.name || "—" : "（未登録）");
  const sname = (id?: string | null) => (id ? b.staff.find(c => c.id === id)?.name || "—" : "—");
  const st = (id: string) => b.stores.find(x => x.id === id)?.name || "";
  return (
    <div className="fixed inset-0 bg-black/30 z-40 flex items-end sm:items-center justify-center" onClick={onClose}>
      <div className="bg-white w-full sm:max-w-4xl rounded-t-xl sm:rounded-xl p-4 max-h-[88vh] overflow-auto" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-2"><div className="font-bold">{row.label} の伝票（{list.length}件・{yenR(list.reduce((a, s) => a + s.total, 0))}）</div><button className="btn" onClick={onClose}>閉じる</button></div>
        <div className="overflow-x-auto"><table className="w-full min-w-[760px]">
          <thead><tr><th className="th">日時</th>{all && <th className="th">店舗</th>}<th className="th">伝票</th><th className="th">お客様</th><th className="th">担当</th><th className="th">明細</th><th className="th">経路</th><th className="th text-right">合計</th><th className="th">次回</th></tr></thead>
          <tbody>{list.map(s => { const bk = s.booking_id ? ctx.bookingById.get(s.booking_id) : undefined; return (
            <tr key={s.id} className={s.status !== "confirmed" ? "text-stone-400" : ""}>
              <td className="td whitespace-nowrap">{localDate(s.sold_at).slice(5).replace("-", "/")} {new Date(s.sold_at).toTimeString().slice(0, 5)}</td>
              {all && <td className="td text-xs">{st(s.store_id)}</td>}
              <td className="td text-xs whitespace-nowrap">{s.sale_no}{s.status === "reversal" ? "（赤伝）" : s.status === "voided" ? "（取消済）" : ""}</td>
              <td className="td whitespace-nowrap">{cname(s.customer_id)}{s.customer_id && isNewCustomer(ctx, s.store_id, s.customer_id, period) && <span className="ml-1 text-[10px] bg-sky-100 text-sky-800 rounded px-1">新規</span>}</td>
              <td className="td whitespace-nowrap">{sname(s.main_staff_id)}</td>
              <td className="td text-xs">{s.lines.map(l => l.name).join("・")}{s.discount ? `（値引${s.discount.toLocaleString()}）` : ""}</td>
              <td className="td text-xs">{bk ? CHANNEL_LABEL[bk.channel] : "—"}</td>
              <td className="td text-right tabular-nums">{yenR(s.total)}</td>
              <td className="td text-xs whitespace-nowrap">{s.status === "confirmed" && s.customer_id ? (hasNextBooking(ctx, s) ? "○" : "") : ""}<span className="text-stone-300 ml-1">{Math.round(treatMin(ctx, s))}分</span></td>
            </tr>); })}</tbody>
        </table></div>
      </div>
    </div>
  );
}
