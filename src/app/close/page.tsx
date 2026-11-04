"use client";
import { useEffect, useState } from "react";
import { getRepo, yen, todayStr, PAY_LABEL, type Sale, type RegisterClosing } from "@/lib/db";

export default function ClosePage() {
  const repo = getRepo();
  const [date, setDate] = useState(todayStr());
  const [sales, setSales] = useState<Sale[]>([]);
  const [c, setC] = useState<Partial<RegisterClosing>>({ opening_float: 30000 });
  const [msg, setMsg] = useState("");

  useEffect(() => { (async () => { setSales(await repo.salesOn(date)); const x = await repo.closing(date); setC(x || { date, opening_float: 30000 }); })(); }, [repo, date]);

  const live = sales.filter(s => s.status !== 'voided');
  const byMethod: Record<string, number> = {};
  for (const s of live) for (const p of s.payments) byMethod[p.method] = (byMethod[p.method] || 0) + p.amount;
  const cashSales = byMethod['cash'] || 0;
  // お釣りは現金売上に含めない：payments の現金は「預かり」なので、現金ちょうど以外は合計との差を引く
  const cashNet = live.reduce((a, s) => { const paid = s.payments.reduce((x, p) => x + p.amount, 0); const cash = s.payments.filter(p => p.method === 'cash').reduce((x, p) => x + p.amount, 0); return a + Math.max(0, cash - Math.max(0, paid - s.total)); }, 0);
  const expected = (c.opening_float || 0) + cashNet;
  const total = live.reduce((a, s) => a + s.total, 0);
  const technical = live.reduce((a, s) => a + s.lines.filter(l => l.kind !== 'product').reduce((x, l) => x + l.amount, 0), 0) - live.reduce((a, s) => a + s.discount, 0);
  const product = live.reduce((a, s) => a + s.lines.filter(l => l.kind === 'product').reduce((x, l) => x + l.amount, 0), 0);
  const counted = c.counted_cash ?? null;
  const diff = counted === null ? null : counted - expected;

  async function save(lock: boolean) {
    const r = await repo.saveClosing({ date, opening_float: c.opening_float || 0, counted_cash: counted, expected_cash: expected, difference: diff, closed_at: lock ? new Date().toISOString() : (c.closed_at || null), note: c.note || null });
    setC(r); setSales(await repo.salesOn(date)); setMsg(lock ? "締めました。以後の伝票修正は管理者のみです。" : "保存しました");
  }
  function csv() {
    const rows = [["日付","伝票","状態","技術","店販","値引","税","合計",...Object.keys(PAY_LABEL).map(k => PAY_LABEL[k])]];
    for (const s of sales) rows.push([date, s.sale_no, s.status, String(s.lines.filter(l => l.kind !== 'product').reduce((x, l) => x + l.amount, 0)), String(s.lines.filter(l => l.kind === 'product').reduce((x, l) => x + l.amount, 0)), String(s.discount), String(s.tax), String(s.total), ...Object.keys(PAY_LABEL).map(k => String(s.payments.filter(p => p.method === k).reduce((x, p) => x + p.amount, 0)))]);
    const blob = new Blob(["﻿" + rows.map(r => r.join(",")).join("\n")], { type: "text/csv" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `売上_${date}.csv`; a.click();
  }

  return (
    <div className="max-w-2xl">
      <div className="flex items-center gap-2 mb-3"><input type="date" className="inp" value={date} onChange={e => setDate(e.target.value)} />{c.closed_at && <span className="text-xs bg-stone-200 px-2 py-0.5 rounded">締め済み</span>}</div>
      <div className="card mb-3">
        <div className="grid grid-cols-2 gap-y-1 text-sm">
          <span>伝票数</span><span className="text-right">{live.length}件（赤伝 {sales.filter(s => s.status === 'reversal').length}）</span>
          <span>技術売上（値引後）</span><span className="text-right">{yen(technical)}</span>
          <span>店販売上</span><span className="text-right">{yen(product)}</span>
          <span className="font-bold border-t pt-1">総売上（税込）</span><span className="text-right font-bold border-t pt-1">{yen(total)}</span>
        </div>
        <div className="lbl mt-3">支払手段別</div>
        <div className="grid grid-cols-2 gap-y-0.5 text-sm">{Object.entries(byMethod).map(([k, v]) => <><span key={k}>{PAY_LABEL[k]}</span><span key={k + 'v'} className="text-right">{yen(v)}</span></>)}</div>
      </div>
      <div className="card mb-3">
        <div className="font-bold mb-2">現金実査</div>
        <div className="grid grid-cols-2 gap-2 text-sm items-center">
          <label>釣銭準備金</label><input type="number" className="inp text-right" value={c.opening_float || 0} disabled={!!c.closed_at} onChange={e => setC({ ...c, opening_float: +e.target.value })} />
          <span>現金売上（お釣り除く）</span><span className="text-right">{yen(cashNet)}<span className="text-xs text-stone-400 ml-1">（預かり {yen(cashSales)}）</span></span>
          <span>あるべき現金</span><span className="text-right font-semibold">{yen(expected)}</span>
          <label>実際の現金（数えた額）</label><input type="number" className="inp text-right" value={counted ?? ''} disabled={!!c.closed_at} onChange={e => setC({ ...c, counted_cash: e.target.value === '' ? null : +e.target.value })} />
          <span>過不足</span><span className={`text-right font-bold ${diff && diff !== 0 ? 'text-rose-600' : ''}`}>{diff === null ? '—' : yen(diff)}</span>
        </div>
        <input className="inp w-full mt-2" placeholder="メモ（過不足の理由など）" value={c.note || ''} disabled={!!c.closed_at} onChange={e => setC({ ...c, note: e.target.value })} />
      </div>
      {msg && <div className="text-emerald-700 text-sm mb-2">{msg}</div>}
      <div className="flex gap-2 justify-end">
        <button className="btn" onClick={csv}>会計用CSV</button>
        {!c.closed_at && <button className="btn" onClick={() => save(false)}>途中保存</button>}
        {!c.closed_at && <button className="btn-primary" disabled={counted === null} onClick={() => { if (confirm('締めると今日の伝票がロックされます。よろしいですか？')) save(true); }}>日次締め</button>}
      </div>
    </div>
  );
}
