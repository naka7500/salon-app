"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { getRepo, type Customer } from "@/lib/db";

export default function CustomersPage() {
  const repo = getRepo();
  const [q, setQ] = useState(""); const [list, setList] = useState<Customer[]>([]); const [adding, setAdding] = useState(false);
  const [n, setN] = useState<Partial<Customer>>({ name: "" });
  const [isAdmin, setIsAdmin] = useState(false);
  useEffect(() => { repo.customers(q).then(setList); }, [repo, q]);
  useEffect(() => { repo.me().then(m => setIsAdmin(!!m && (m.role === "owner" || m.role === "manager"))).catch(() => {}); }, [repo]);
  async function add() { if (!n.name) return; await repo.upsertCustomer({ ...n, name: n.name! }); setN({ name: "" }); setAdding(false); setList(await repo.customers(q)); }
  return (
    <div className="max-w-3xl">
      <div className="flex gap-2 mb-3"><input className="inp flex-1" placeholder="名前・カナ・電話で検索" value={q} onChange={e => setQ(e.target.value)} /><button className="btn-primary" onClick={() => setAdding(!adding)}>＋新規</button>{isAdmin && <Link href="/settings/import" className="btn">CSV取り込み</Link>}</div>
      {adding && <div className="card mb-3 grid grid-cols-2 gap-2">
        <input className="inp" placeholder="氏名*" value={n.name || ''} onChange={e => setN({ ...n, name: e.target.value })} />
        <input className="inp" placeholder="フリガナ" value={n.kana || ''} onChange={e => setN({ ...n, kana: e.target.value })} />
        <input className="inp" placeholder="電話" value={n.phone || ''} onChange={e => setN({ ...n, phone: e.target.value })} />
        <input className="inp" placeholder="生年月 1990-04" value={n.birth_month || ''} onChange={e => setN({ ...n, birth_month: e.target.value })} />
        <select className="inp" value={n.source || ''} onChange={e => setN({ ...n, source: e.target.value })}><option value="">流入経路</option><option value="hpb">HPB</option><option value="own">自社</option><option value="line">LINE</option><option value="referral">紹介</option><option value="walkin">通りがかり</option></select>
        <button className="btn-primary" onClick={add}>登録</button>
      </div>}
      <div className="card p-0 overflow-hidden"><table className="w-full"><thead><tr><th className="th">氏名</th><th className="th">電話</th><th className="th">経路</th><th className="th">登録</th></tr></thead>
        <tbody>{list.map(c => <tr key={c.id} className="hover:bg-emerald-50"><td className="td"><Link href={`/customers/${c.id}`} className="text-canopy font-semibold">{c.name}</Link><div className="text-[10px] text-stone-400">{c.kana}</div></td><td className="td">{c.phone}</td><td className="td text-xs">{c.source}</td><td className="td text-xs">{c.created_at.slice(0, 10)}</td></tr>)}</tbody></table></div>
    </div>
  );
}
