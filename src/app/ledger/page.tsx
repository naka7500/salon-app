"use client";
// 売上台帳：伝票一覧（検索）・日計表・月次台帳・会計用CSV（freee取込を意識）
// 締め後の修正は赤伝のみ。締め後の赤伝は owner・manager だけ（フェーズC）。赤伝は必ず修正履歴（audit_logs）に残る。
// 金額は「元伝票＋赤伝」で相殺して数える。
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { getRepo, todayStr, yen, PAY_LABEL, staffLabel, type Sale, type Staff, type Customer, type RegisterClosing, type Store, type AuditLog } from "@/lib/db";
import { addDays, addMonths, monthDays, localDate, WD, dow } from "@/lib/schedule";
import { netPayments } from "@/lib/money";

type Tab = "list" | "daily" | "monthly" | "audit";
const TAB_LABEL: Record<Tab, string> = { list: "伝票一覧", daily: "日計表", monthly: "月次台帳", audit: "修正履歴" };
const ACTION_LABEL: Record<string, string> = { reverse: "赤伝（締め前）", reverse_after_close: "締め後の赤伝" };
const ROLE_JA: Record<string, string> = { owner: "オーナー", manager: "店長", staff: "スタッフ", viewer: "閲覧" };
const METHODS = Object.keys(PAY_LABEL);

function downloadCsv(name: string, rows: (string | number)[][]) {
  const csv = "﻿" + rows.map(r => r.map(v => { const s = String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }).join(",")).join("\r\n");
  const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" })); a.download = name; a.click(); URL.revokeObjectURL(a.href);
}
const hm = (iso: string) => new Date(iso).toTimeString().slice(0, 5);
const techOf = (s: Sale) => s.lines.filter(l => l.kind !== "product").reduce((a, l) => a + l.amount, 0) - s.discount;
const prodOf = (s: Sale) => s.lines.filter(l => l.kind === "product").reduce((a, l) => a + l.amount, 0);
const statusLabel = (s: Sale) => (s.status === "reversal" ? "赤伝" : s.status === "voided" ? "赤伝済（取消）" : "確定");
const taxLabel = (s: Sale) => { const r = [...new Set(s.lines.map(l => Number(l.tax_rate)))]; if (r.length > 1) return "混在（要確認）"; return r[0] === 0.08 ? "課税売上8%（軽）" : r[0] === 0 ? "非課税売上" : "課税売上10%"; };

export default function LedgerPage() {
  const repo = getRepo();
  const today = todayStr();
  const [tab, setTab] = useState<Tab>("list");
  const [from, setFrom] = useState(today.slice(0, 7) + "-01");
  const [to, setTo] = useState(today);
  const [day, setDay] = useState(today);
  const [ym, setYm] = useState(today.slice(0, 7));
  const [qCust, setQCust] = useState("");
  const [qStaff, setQStaff] = useState("");
  const [qMin, setQMin] = useState("");
  const [qMax, setQMax] = useState("");
  const [qRev, setQRev] = useState(false);
  const [store, setStore] = useState<Store | null>(null);
  const [staff, setStaff] = useState<Staff[]>([]);
  const [sales, setSales] = useState<Sale[]>([]);
  const [custs, setCusts] = useState<Record<string, Customer>>({});
  const [closing, setClosing] = useState<RegisterClosing | undefined>();
  const [detail, setDetail] = useState<Sale | null>(null);
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState("");
  const [me, setMe] = useState<Staff | null>(null);
  const [revReason, setRevReason] = useState(""); const [revErr, setRevErr] = useState("");
  const [audits, setAudits] = useState<AuditLog[] | null>([]);
  const canCloseReverse = !!me && (me.role === "owner" || me.role === "manager");

  // 表示に必要な期間
  const range = useMemo(() => {
    if (tab === "daily") return { from: day, to: addDays(day, 1) };
    if (tab === "monthly") { const d = monthDays(ym); return { from: d[0], to: addDays(d[d.length - 1], 1) }; }
    return from <= to ? { from, to: addDays(to, 1) } : { from: to, to: addDays(from, 1) };
  }, [tab, day, ym, from, to]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const ss = await repo.salesBetween(range.from, range.to);
      setSales(ss);
      const ids = [...new Set(ss.map(s => s.customer_id).filter(Boolean) as string[])];
      const cs = ids.length ? await repo.customersByIds(ids) : [];
      setCusts(Object.fromEntries(cs.map(c => [c.id, c])));
      if (tab === "daily") setClosing(await repo.closing(day)); else setClosing(undefined);
      if (tab === "audit") setAudits(await repo.auditLogs(range.from, range.to));
    } finally { setLoading(false); }
  }, [repo, range, tab, day]);
  useEffect(() => { (async () => { setStore(await repo.store()); setStaff(await repo.allStaff().catch(() => repo.staff())); setMe(await repo.me().catch(() => null)); })(); }, [repo]);
  useEffect(() => { void Promise.resolve().then(load); }, [load]);

  const cname = (id?: string | null) => (id ? custs[id]?.name || "—" : "（未登録）");
  const sname = (id?: string | null) => (id ? staff.find(s => s.id === id)?.name || "—" : "—");
  const reversedIds = new Set(sales.filter(s => s.status === "reversal" && s.reverses_sale_id).map(s => s.reverses_sale_id!));

  // ---- 伝票一覧の検索 ----
  const filtered = useMemo(() => sales.filter(s => {
    if (qCust && !(cname(s.customer_id) + (custs[s.customer_id || ""]?.kana || "")).includes(qCust)) return false;
    if (qStaff && s.main_staff_id !== qStaff && !s.lines.some(l => l.staff_id === qStaff)) return false;
    if (qMin && Math.abs(s.total) < Number(qMin)) return false;
    if (qMax && Math.abs(s.total) > Number(qMax)) return false;
    if (qRev && s.status === "confirmed") return false;
    return true;
  }), [sales, qCust, qStaff, qMin, qMax, qRev, custs]); // eslint-disable-line react-hooks/exhaustive-deps

  const sum = (list: Sale[]) => {
    const pay: Record<string, number> = {};
    for (const s of list) for (const [m, v] of Object.entries(netPayments(s))) pay[m] = (pay[m] || 0) + v;
    return { total: list.reduce((a, s) => a + s.total, 0), tech: list.reduce((a, s) => a + techOf(s), 0), prod: list.reduce((a, s) => a + prodOf(s), 0), discount: list.reduce((a, s) => a + s.discount, 0),
      tax: list.reduce((a, s) => a + s.tax, 0), count: list.filter(s => s.status === "confirmed").length, rev: list.filter(s => s.status === "reversal"), pay };
  };

  // ---- 月次台帳 ----
  const monthRows = useMemo(() => tab !== "monthly" ? [] : monthDays(ym).map(d => ({ d, ...sum(sales.filter(s => localDate(s.sold_at) === d)) })), [tab, ym, sales]); // eslint-disable-line react-hooks/exhaustive-deps
  const usedMethods = METHODS.filter(m => sales.some(s => s.payments.some(p => p.method === m)));

  // ---- 会計用CSV（freee取込を意識） ----
  function freeeCsv(mode: "slip" | "daily") {
    const head = ["取引日", "伝票番号", "勘定科目候補", "税区分", "金額（税込）", "支払方法", "摘要"];
    const rows: (string | number)[][] = [head];
    const list = [...sales].sort((a, b) => a.sold_at.localeCompare(b.sold_at));
    if (mode === "slip") {
      for (const s of list) for (const [m, v] of Object.entries(netPayments(s))) if (v) rows.push([localDate(s.sold_at).replace(/-/g, "/"), s.sale_no, "売上高", taxLabel(s), v, PAY_LABEL[m] || m,
        [store?.name, cname(s.customer_id), s.lines.map(l => l.name).join("・"), s.status === "reversal" ? `赤伝（元 ${list.find(x => x.id === s.reverses_sale_id)?.sale_no || ""}）` : s.status === "voided" ? "赤伝で取消済" : "", s.discount ? `値引${s.discount}` : ""].filter(Boolean).join(" ")]);
    } else {
      const days = [...new Set(list.map(s => localDate(s.sold_at)))];
      for (const d of days) { const x = sum(list.filter(s => localDate(s.sold_at) === d)); for (const [m, v] of Object.entries(x.pay)) if (v) rows.push([d.replace(/-/g, "/"), "", "売上高", "課税売上10%", v, PAY_LABEL[m] || m, `${store?.name || ""} ${d} 売上（${PAY_LABEL[m] || m}・伝票${x.count}件${x.rev.length ? `・赤伝${x.rev.length}件` : ""}）`]); }
    }
    downloadCsv(`会計用_${store?.name || ""}_${range.from}_${addDays(range.to, -1)}_${mode === "slip" ? "伝票ごと" : "日別まとめ"}.csv`, rows);
  }
  function listCsv() {
    const rows: (string | number)[][] = [["日付", "時刻", "伝票番号", "状態", "お客様", "担当", "明細", "技術", "店販", "値引", "消費税", "合計", ...METHODS.map(m => PAY_LABEL[m]), "締め"]];
    for (const s of filtered) { const p = netPayments(s); rows.push([localDate(s.sold_at), hm(s.sold_at), s.sale_no, statusLabel(s), cname(s.customer_id), sname(s.main_staff_id), s.lines.map(l => `${l.name}×${l.qty}`).join("・"), techOf(s), prodOf(s), s.discount, s.tax, s.total, ...METHODS.map(m => p[m] || 0), s.closed_on ? "済" : ""]); }
    downloadCsv(`伝票一覧_${store?.name || ""}_${range.from}_${addDays(range.to, -1)}.csv`, rows);
  }
  function monthCsv() {
    const rows: (string | number)[][] = [["日付", "曜日", "伝票数", "技術", "店販", "値引", "赤伝", "総売上", ...usedMethods.map(m => PAY_LABEL[m])]];
    for (const r of monthRows) rows.push([r.d, WD[dow(r.d)], r.count, r.tech, r.prod, r.discount, r.rev.reduce((a, s) => a + s.total, 0), r.total, ...usedMethods.map(m => r.pay[m] || 0)]);
    const t = sum(sales); rows.push(["合計", "", t.count, t.tech, t.prod, t.discount, t.rev.reduce((a, s) => a + s.total, 0), t.total, ...usedMethods.map(m => t.pay[m] || 0)]);
    downloadCsv(`月次台帳_${store?.name || ""}_${ym}.csv`, rows);
  }

  async function reverse(s: Sale) {
    const r = revReason.trim();
    if (!r) { setRevErr("理由を入れてください（修正履歴に残ります）"); return; }
    try { await repo.reverseSale(s.id, r); setDetail(null); setRevReason(""); setRevErr(""); setMsg(`伝票 ${s.sale_no} を赤伝にしました${s.closed_on ? "（締め後の修正として修正履歴に記録）" : ""}`); await load(); } catch (e) { setRevErr((e as Error).message); }
  }

  const tot = sum(tab === "list" ? filtered : sales);
  return (
    <div className="max-w-6xl">
      <div className="flex flex-wrap items-center gap-2 mb-2">
        <h1 className="text-xl font-bold mr-1">売上台帳</h1>
        <div className="inline-flex border rounded overflow-hidden" role="tablist">
          {(Object.keys(TAB_LABEL) as Tab[]).map(t => <button key={t} role="tab" aria-selected={tab === t} onClick={() => { setTab(t); setMsg(""); }} className={`px-3 py-1.5 text-sm border-r last:border-r-0 ${tab === t ? "bg-[#2f6b4f] text-white font-semibold" : "bg-white hover:bg-stone-100"}`}>{TAB_LABEL[t]}</button>)}
        </div>
        {tab === "audit" && <div className="flex gap-1 items-center text-sm"><input type="date" className="inp" value={from} onChange={e => setFrom(e.target.value)} />〜<input type="date" className="inp" value={to} onChange={e => setTo(e.target.value)} /></div>}
        {tab === "daily" && <div className="flex gap-1"><button className="btn" onClick={() => setDay(addDays(day, -1))}>前日</button><input type="date" className="inp" value={day} onChange={e => e.target.value && setDay(e.target.value)} /><button className="btn" onClick={() => setDay(addDays(day, 1))}>次日</button></div>}
        {tab === "monthly" && <div className="flex gap-1"><button className="btn" onClick={() => setYm(addMonths(ym, -1))}>前月</button><input type="month" className="inp" value={ym} onChange={e => e.target.value && setYm(e.target.value)} /><button className="btn" onClick={() => setYm(addMonths(ym, 1))}>次月</button></div>}
        <div className="ml-auto flex flex-wrap gap-1">
          {tab === "list" && <button className="btn" onClick={listCsv}>一覧CSV</button>}
          {tab === "audit" && audits && audits.length > 0 && <button className="btn" onClick={() => downloadCsv(`修正履歴_${store?.name || ""}_${range.from}_${addDays(range.to, -1)}.csv`, [["日時", "操作", "伝票番号", "金額", "理由", "実行者", "役割", "締め日"], ...audits.map(a => [new Date(a.at).toLocaleString("ja-JP"), ACTION_LABEL[a.action] || a.action, String(a.before?.sale_no ?? ""), Number(a.before?.total ?? 0), a.reason || "", a.actor_name || "", ROLE_JA[String(a.after?.role ?? "")] || "", String(a.before?.closed_on ?? "")])])}>修正履歴CSV</button>}
          {tab === "monthly" && <button className="btn" onClick={monthCsv}>月次台帳CSV</button>}
          {tab !== "audit" && <><button className="btn" onClick={() => freeeCsv("slip")} title="freeeの取引インポート用（1伝票×支払方法で1行）">会計用CSV（伝票ごと）</button>
          <button className="btn" onClick={() => freeeCsv("daily")} title="1日×支払方法で1行にまとめたもの">会計用CSV（日別まとめ）</button></>}
        </div>
      </div>
      {msg && <div className="mb-2 text-sm px-3 py-2 rounded bg-emerald-50 text-emerald-800 border border-emerald-200">{msg}</div>}
      {loading && <div className="text-xs text-stone-500 mb-1">読み込み中…</div>}

      {tab === "list" && <>
        <div className="card mb-2 flex flex-wrap items-end gap-2 text-sm">
          <div><label className="lbl">期間</label><div className="flex items-center gap-1"><input type="date" className="inp" value={from} onChange={e => setFrom(e.target.value)} />〜<input type="date" className="inp" value={to} onChange={e => setTo(e.target.value)} /></div></div>
          <div><label className="lbl">お客様</label><input className="inp w-32" placeholder="名前・カナ" value={qCust} onChange={e => setQCust(e.target.value)} /></div>
          <div><label className="lbl">担当</label><select className="inp" value={qStaff} onChange={e => setQStaff(e.target.value)}><option value="">全員</option>{staff.map(s => <option key={s.id} value={s.id}>{staffLabel(s)}</option>)}</select></div>
          <div><label className="lbl">金額</label><div className="flex items-center gap-1"><input className="inp w-24 text-right" inputMode="numeric" placeholder="下限" value={qMin} onChange={e => setQMin(e.target.value)} />〜<input className="inp w-24 text-right" inputMode="numeric" placeholder="上限" value={qMax} onChange={e => setQMax(e.target.value)} /></div></div>
          <label className="inline-flex items-center gap-1 pb-1.5"><input type="checkbox" checked={qRev} onChange={e => setQRev(e.target.checked)} />赤伝だけ</label>
          <div className="ml-auto text-right pb-1"><div className="text-xs text-stone-500">{filtered.length}伝票（確定 {tot.count}件・赤伝 {tot.rev.length}件）</div><div className="font-bold tabular-nums">{yen(tot.total)}</div></div>
        </div>
        <div className="card overflow-x-auto">
          <table className="w-full min-w-[860px]">
            <thead><tr><th className="th">日付</th><th className="th">伝票番号</th><th className="th">お客様</th><th className="th">担当</th><th className="th">明細</th><th className="th text-right">値引</th><th className="th text-right">合計</th><th className="th">支払方法</th><th className="th">赤伝</th><th className="th">締め</th></tr></thead>
            <tbody>{filtered.map(s => { const p = netPayments(s); return (
              <tr key={s.id} onClick={() => setDetail(s)} className={`cursor-pointer hover:bg-emerald-50 ${s.status === "voided" ? "text-stone-400" : s.status === "reversal" ? "text-rose-700" : ""}`}>
                <td className="td whitespace-nowrap">{localDate(s.sold_at).slice(5).replace("-", "/")} <span className="text-xs text-stone-500">{hm(s.sold_at)}</span></td>
                <td className="td text-xs whitespace-nowrap">{s.sale_no}</td>
                <td className="td whitespace-nowrap">{cname(s.customer_id)}</td>
                <td className="td whitespace-nowrap">{sname(s.main_staff_id)}</td>
                <td className="td text-xs">{s.lines.map(l => <span key={l.id} className="inline-block mr-1"><span className={`px-1 rounded text-[10px] mr-0.5 ${l.kind === "product" ? "bg-sky-100 text-sky-800" : l.kind === "option" ? "bg-violet-100 text-violet-800" : "bg-emerald-100 text-emerald-800"}`}>{l.kind === "product" ? "店販" : l.kind === "option" ? "OP" : "技術"}</span>{l.name}{Math.abs(l.qty) !== 1 ? `×${l.qty}` : ""}</span>)}</td>
                <td className="td text-right tabular-nums">{s.discount ? yen(s.discount) : ""}</td>
                <td className="td text-right tabular-nums font-semibold">{yen(s.total)}</td>
                <td className="td text-xs whitespace-nowrap">{Object.entries(p).filter(([, v]) => v).map(([m, v]) => `${PAY_LABEL[m]} ${v.toLocaleString()}`).join("／")}</td>
                <td className="td text-xs whitespace-nowrap">{s.status === "reversal" ? "赤伝" : s.status === "voided" || reversedIds.has(s.id) ? "取消済" : ""}</td>
                <td className="td text-xs">{s.closed_on ? "済" : ""}</td>
              </tr>); })}
              {!filtered.length && <tr><td className="td text-stone-400" colSpan={10}>該当する伝票はありません</td></tr>}
            </tbody>
          </table>
        </div>
      </>}

      {tab === "daily" && (
        <div className="grid md:grid-cols-2 gap-2">
          <div className="card">
            <div className="font-bold mb-2">{day.replace(/-/g, "/")}（{WD[dow(day)]}）の日計表</div>
            <div className="grid grid-cols-2 gap-y-1 text-sm">
              <span>伝票数</span><span className="text-right">{tot.count}件（赤伝 {tot.rev.length}件）</span>
              <span>技術売上（値引後）</span><span className="text-right tabular-nums">{yen(tot.tech)}</span>
              <span>店販売上</span><span className="text-right tabular-nums">{yen(tot.prod)}</span>
              <span>値引</span><span className="text-right tabular-nums">{yen(tot.discount)}</span>
              <span>赤伝</span><span className="text-right tabular-nums">{yen(tot.rev.reduce((a, s) => a + s.total, 0))}</span>
              <span className="font-bold border-t pt-1">総売上（税込）</span><span className="text-right font-bold border-t pt-1 tabular-nums">{yen(tot.total)}</span>
              <span className="text-stone-500">うち消費税</span><span className="text-right text-stone-500 tabular-nums">{yen(tot.tax)}</span>
            </div>
          </div>
          <div className="card">
            <div className="font-bold mb-2">支払方法別</div>
            <table className="w-full"><tbody>
              {Object.entries(tot.pay).filter(([, v]) => v).map(([m, v]) => <tr key={m}><td className="td">{PAY_LABEL[m]}</td><td className="td text-right tabular-nums">{yen(v)}</td></tr>)}
              <tr><td className="td font-bold">合計</td><td className="td text-right font-bold tabular-nums">{yen(Object.values(tot.pay).reduce((a, v) => a + v, 0))}</td></tr>
            </tbody></table>
            <div className="text-[11px] text-stone-500 mt-1">現金はお釣りを引いた額（売上として残る現金）。</div>
            <div className="mt-3 text-sm border-t pt-2">
              <div className="font-semibold mb-1">レジ締め</div>
              {closing ? <div className="grid grid-cols-2 gap-y-0.5">
                <span>状態</span><span className="text-right">{closing.closed_at ? "締め済み" : "途中保存"}</span>
                <span>あるべき現金</span><span className="text-right tabular-nums">{closing.expected_cash != null ? yen(closing.expected_cash) : "—"}</span>
                <span>数えた現金</span><span className="text-right tabular-nums">{closing.counted_cash != null ? yen(closing.counted_cash) : "—"}</span>
                <span>過不足</span><span className={`text-right tabular-nums font-semibold ${closing.difference ? "text-rose-600" : ""}`}>{closing.difference != null ? yen(closing.difference) : "—"}</span>
              </div> : <div className="text-stone-500">まだ締めていません。</div>}
              <Link href="/close" className="btn inline-block mt-2 text-xs">レジ締め画面へ</Link>
            </div>
          </div>
        </div>
      )}

      {tab === "monthly" && (
        <div className="card overflow-x-auto">
          <table className="w-full min-w-[760px]">
            <thead><tr><th className="th">日付</th><th className="th text-right">伝票</th><th className="th text-right">技術</th><th className="th text-right">店販</th><th className="th text-right">値引</th><th className="th text-right">赤伝</th><th className="th text-right">総売上</th>{usedMethods.map(m => <th key={m} className="th text-right">{PAY_LABEL[m]}</th>)}</tr></thead>
            <tbody>
              {monthRows.map(r => <tr key={r.d} className={r.count || r.total ? "" : "text-stone-300"}>
                <td className={`td whitespace-nowrap ${dow(r.d) === 0 ? "text-rose-600" : dow(r.d) === 6 ? "text-sky-700" : ""}`}>{Number(r.d.slice(8))}日（{WD[dow(r.d)]}）</td>
                <td className="td text-right tabular-nums">{r.count || ""}</td><td className="td text-right tabular-nums">{r.tech ? r.tech.toLocaleString() : ""}</td><td className="td text-right tabular-nums">{r.prod ? r.prod.toLocaleString() : ""}</td>
                <td className="td text-right tabular-nums">{r.discount ? r.discount.toLocaleString() : ""}</td><td className="td text-right tabular-nums text-rose-700">{r.rev.length ? r.rev.reduce((a, s) => a + s.total, 0).toLocaleString() : ""}</td>
                <td className="td text-right tabular-nums font-semibold">{r.total ? r.total.toLocaleString() : ""}</td>
                {usedMethods.map(m => <td key={m} className="td text-right tabular-nums">{r.pay[m] ? r.pay[m].toLocaleString() : ""}</td>)}
              </tr>)}
              <tr className="bg-stone-50 font-bold"><td className="td">合計</td><td className="td text-right">{tot.count}</td><td className="td text-right tabular-nums">{tot.tech.toLocaleString()}</td><td className="td text-right tabular-nums">{tot.prod.toLocaleString()}</td><td className="td text-right tabular-nums">{tot.discount.toLocaleString()}</td><td className="td text-right tabular-nums text-rose-700">{tot.rev.reduce((a, s) => a + s.total, 0).toLocaleString()}</td><td className="td text-right tabular-nums">{tot.total.toLocaleString()}</td>{usedMethods.map(m => <td key={m} className="td text-right tabular-nums">{(tot.pay[m] || 0).toLocaleString()}</td>)}</tr>
            </tbody>
          </table>
        </div>
      )}
      {tab === "audit" && (
        <div className="card overflow-x-auto">
          {audits === null ? <div className="text-sm text-stone-600">修正履歴は準備中です（DB更新 0007 の後に使えます）。</div>
            : audits.length === 0 ? <div className="text-sm text-stone-500">この期間の修正はありません。</div>
            : <table className="w-full"><thead><tr><th className="th">日時</th><th className="th">操作</th><th className="th">伝票番号</th><th className="th text-right">金額</th><th className="th">理由</th><th className="th">実行者</th><th className="th">元の締め日</th></tr></thead>
              <tbody>{audits.map(a => <tr key={String(a.id)} className={a.action === "reverse_after_close" ? "bg-rose-50/60" : ""}>
                <td className="td whitespace-nowrap text-xs">{new Date(a.at).toLocaleString("ja-JP", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}</td>
                <td className="td text-xs whitespace-nowrap"><span className={`px-1.5 py-0.5 rounded ${a.action === "reverse_after_close" ? "bg-rose-200 text-rose-900" : "bg-stone-100"}`}>{ACTION_LABEL[a.action] || a.action}</span></td>
                <td className="td text-xs">{String(a.before?.sale_no ?? "")}{a.after?.reversal_sale_no ? <span className="text-stone-400"> → {String(a.after.reversal_sale_no)}</span> : null}</td>
                <td className="td text-right tabular-nums">{yen(Number(a.before?.total ?? 0))}</td>
                <td className="td text-sm">{a.reason}</td>
                <td className="td text-xs whitespace-nowrap">{a.actor_name}{a.after?.role ? `（${ROLE_JA[String(a.after.role)] || String(a.after.role)}）` : ""}</td>
                <td className="td text-xs">{String(a.before?.closed_on ?? "—")}</td>
              </tr>)}</tbody></table>}
          <div className="text-[11px] text-stone-500 mt-2">赤伝はすべてここに残ります（誰が・いつ・どの伝票・理由）。締め後の赤伝はオーナー・店長だけができ、本番ではDB側でも権限を確認しています。</div>
        </div>
      )}
      <div className="text-[11px] text-stone-500 mt-2">※会計用CSVの列：取引日・伝票番号・勘定科目候補（売上高）・税区分（課税売上10%）・金額（税込）・支払方法・摘要。freeeでは「取引のインポート」で支払方法ごとに決済口座を割り当ててください。赤伝はマイナスの行で出ます。</div>

      {detail && (
        <div className="fixed inset-0 bg-black/30 z-40 flex items-end sm:items-center justify-center" onClick={() => setDetail(null)}>
          <div className="bg-white w-full sm:max-w-lg rounded-t-xl sm:rounded-xl p-4 max-h-[90vh] overflow-auto" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-2"><div className="font-bold">伝票 {detail.sale_no}<span className="ml-2 text-xs font-normal px-1.5 py-0.5 rounded bg-stone-100">{statusLabel(detail)}</span>{detail.closed_on && <span className="ml-1 text-xs font-normal px-1.5 py-0.5 rounded bg-stone-200">締め済み</span>}</div><button className="btn" onClick={() => setDetail(null)}>閉じる</button></div>
            <div className="text-sm text-stone-600 mb-2">{localDate(detail.sold_at).replace(/-/g, "/")} {hm(detail.sold_at)}／{cname(detail.customer_id)}／担当 {sname(detail.main_staff_id)}</div>
            <table className="w-full mb-2"><tbody>
              {detail.lines.map(l => <tr key={l.id}><td className="td">{l.name}</td><td className="td text-right">{l.qty}</td><td className="td text-right tabular-nums">{yen(l.amount)}</td></tr>)}
              {detail.discount !== 0 && <tr><td className="td">値引{detail.discount_reason ? `（${detail.discount_reason}）` : ""}</td><td className="td" /><td className="td text-right tabular-nums">-{yen(detail.discount)}</td></tr>}
              <tr><td className="td font-bold">合計（税込）</td><td className="td" /><td className="td text-right font-bold tabular-nums">{yen(detail.total)}</td></tr>
            </tbody></table>
            <div className="text-sm mb-2">支払：{detail.payments.map(p => `${PAY_LABEL[p.method]} ${yen(p.amount)}`).join("／")}</div>
            {detail.note && <div className="text-sm text-stone-600 mb-2">メモ：{detail.note}</div>}
            {detail.status === "confirmed" && (!detail.closed_on || canCloseReverse) && me?.role !== "viewer" && (
              <div className={`border rounded p-2 ${detail.closed_on ? "border-rose-300 bg-rose-50" : "border-stone-200 bg-stone-50"}`}>
                <div className="text-sm font-semibold mb-1">{detail.closed_on ? "締め後の赤伝（オーナー・店長だけ）" : "赤伝にする（取消）"}</div>
                {detail.closed_on && <div className="text-xs text-rose-800 mb-1">この伝票は {detail.closed_on} に締め済みです。赤伝は今日の日付でマイナス伝票として入り、誰が・いつ・理由が修正履歴に残ります。</div>}
                <input className="inp w-full mb-1" placeholder="理由（例：金額の打ち間違い・支払方法の間違い）" value={revReason} onChange={e => { setRevReason(e.target.value); setRevErr(""); }} aria-label="赤伝の理由" />
                {revErr && <div className="text-xs text-rose-600 mb-1">{revErr}</div>}
                <div className="flex justify-end"><button className="btn text-rose-700 border-rose-300" onClick={() => reverse(detail)}>{detail.closed_on ? "締め後の赤伝を切る" : "赤伝にする"}</button></div>
              </div>
            )}
            {detail.status === "confirmed" && detail.closed_on && !canCloseReverse && <div className="text-xs text-stone-600 bg-stone-100 rounded p-2">締め済みの伝票です。締め後の修正（赤伝）はオーナー・店長だけができます。店長に依頼してください。</div>}
          </div>
        </div>
      )}
    </div>
  );
}
