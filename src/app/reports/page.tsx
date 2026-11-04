"use client";
import { useEffect, useState } from "react";
import { getRepo, yen, todayStr, type Sale, type Staff, type Customer, type Booking } from "@/lib/db";

function monthDays(ym: string) { const [y, m] = ym.split("-").map(Number); const n = new Date(y, m, 0).getDate(); return Array.from({ length: n }, (_, i) => `${ym}-${String(i + 1).padStart(2, '0')}`); }

export default function ReportsPage() {
  const repo = getRepo();
  const [ym, setYm] = useState(todayStr().slice(0, 7));
  const [days, setDays] = useState<{ d: string; sales: Sale[]; bookings: Booking[] }[]>([]);
  const [staff, setStaff] = useState<Staff[]>([]); const [customers, setCustomers] = useState<Customer[]>([]);
  useEffect(() => { (async () => { setStaff(await repo.staff()); setCustomers(await repo.customers()); const out = []; for (const d of monthDays(ym)) out.push({ d, sales: (await repo.salesOn(d)).filter(s => s.status !== 'voided'), bookings: await repo.bookingsOn(d) }); setDays(out); })(); }, [repo, ym]);
  const all = days.flatMap(x => x.sales);
  const total = all.reduce((a, s) => a + s.total, 0);
  const cnt = all.filter(s => s.status === 'confirmed').length;
  const product = all.reduce((a, s) => a + s.lines.filter(l => l.kind === 'product').reduce((x, l) => x + l.amount, 0), 0);
  const today = todayStr(); const elapsed = Math.max(1, days.filter(x => x.d <= today).length);
  const pace = Math.round(total / elapsed * days.length);
  const firstVisit = (s: Sale) => { if (!s.customer_id) return false; const prev = all.filter(x => x.customer_id === s.customer_id && x.sold_at < s.sold_at); return prev.length === 0 && (customers.find(c => c.id === s.customer_id)?.created_at.slice(0, 7) === ym); };
  const newCnt = all.filter(firstVisit).length;
  const byStaff = staff.map(st => { const ss = all.filter(s => s.main_staff_id === st.id); const t = ss.reduce((a, s) => a + s.total, 0); const done = days.flatMap(x => x.bookings).filter(b => b.staff_id === st.id && b.status === 'done'); const next = done.filter(b => days.flatMap(x => x.bookings).some(n => n.customer_id === b.customer_id && n.start_at > b.start_at)); return { st, t, n: ss.length, unit: ss.length ? Math.round(t / ss.length) : 0, nominated: done.filter(b => b.nominated).length, nextRate: done.length ? Math.round(100 * next.length / done.length) : 0 }; });
  return (
    <div className="max-w-4xl">
      <div className="flex items-center gap-2 mb-3"><input type="month" className="inp" value={ym} onChange={e => setYm(e.target.value)} /><span className="text-xs text-stone-500">※数字はこのアプリに入れた会計だけ。サロンボード側の数字は含みません</span></div>
      <div className="grid grid-cols-2 md:grid-cols-5 gap-2 mb-3">
        {[["総売上", yen(total)], ["客数", `${cnt}人`], ["客単価", cnt ? yen(Math.round(total / cnt)) : '—'], ["新規", `${newCnt}人`], ["月末ペース", yen(pace)]].map(([k, v]) => <div key={k} className="card"><div className="text-xs text-stone-500">{k}</div><div className="text-lg font-bold">{v}</div></div>)}
      </div>
      <div className="card mb-3"><div className="font-bold mb-1">スタッフ別</div><table className="w-full"><thead><tr><th className="th">担当</th><th className="th text-right">売上</th><th className="th text-right">客数</th><th className="th text-right">客単価</th><th className="th text-right">指名</th><th className="th text-right">次回予約率</th></tr></thead>
        <tbody>{byStaff.map(r => <tr key={r.st.id}><td className="td">{r.st.name}</td><td className="td text-right">{yen(r.t)}</td><td className="td text-right">{r.n}</td><td className="td text-right">{yen(r.unit)}</td><td className="td text-right">{r.nominated}</td><td className="td text-right">{r.nextRate}%</td></tr>)}</tbody></table>
        <div className="text-[10px] text-stone-400 mt-1">店販合計 {yen(product)}。次回予約率＝会計済みのうち、その後の予約が台帳にある人の割合</div></div>
      <div className="card"><div className="font-bold mb-1">日別</div><table className="w-full"><thead><tr><th className="th">日</th><th className="th text-right">予約</th><th className="th text-right">会計</th><th className="th text-right">売上</th></tr></thead>
        <tbody>{days.filter(x => x.sales.length || x.bookings.length).map(x => <tr key={x.d}><td className="td">{x.d.slice(5)}</td><td className="td text-right">{x.bookings.filter(b => !['cancelled','block'].includes(b.status)).length}</td><td className="td text-right">{x.sales.filter(s => s.status === 'confirmed').length}</td><td className="td text-right">{yen(x.sales.reduce((a, s) => a + s.total, 0))}</td></tr>)}</tbody></table></div>
    </div>
  );
}
