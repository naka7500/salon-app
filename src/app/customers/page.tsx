"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { getRepo, type Customer } from "@/lib/db";
import { lineStatusOf, type LineStatus } from "@/lib/line/manual";

// 一覧の小さな LINE の印（つながっている人・配信停止中の人だけ出す）
function LineMark({ status }: { status?: LineStatus }) {
  if (status === "linked") return <span className="chip !px-1.5 bg-[#06c755] text-white font-bold" title="LINEでつながっている" aria-label="LINEでつながっている" data-testid="line-mark">LINE</span>;
  if (status === "stopped") return <span className="chip !px-1.5 bg-stone-200 text-stone-600" title="LINEの配信停止中" aria-label="LINEの配信停止中" data-testid="line-mark">LINE停止</span>;
  return null;
}

export default function CustomersPage() {
  const repo = getRepo();
  const router = useRouter();
  const [q, setQ] = useState(""); const [list, setList] = useState<Customer[]>([]); const [adding, setAdding] = useState(false);
  const [n, setN] = useState<Partial<Customer>>({ name: "" });
  const [isAdmin, setIsAdmin] = useState(false);
  // 検索はサーバで（入力が止まってから）。一覧は100人ずつ「もっと見る」
  const PAGE = 100;
  const [more, setMore] = useState(false);
  useEffect(() => { let on = true; const t = setTimeout(() => { repo.customers(q, { limit: PAGE }).then(r => { if (on) { setList(r); setMore(r.length === PAGE); } }); }, q ? 250 : 0); return () => { on = false; clearTimeout(t); }; }, [repo, q]);
  async function loadMore() { const r = await repo.customers(q, { limit: PAGE, offset: list.length }); setList([...list, ...r]); setMore(r.length === PAGE); }
  // LINE の印：表示中のお客様の分だけ、まとめて1回読む（0015 未適用なら出さない。失敗しても一覧はそのまま）
  const [lineMap, setLineMap] = useState<Map<string, LineStatus>>(new Map());
  useEffect(() => {
    let on = true;
    if (!list.length) return;
    repo.lineLinks(list.map(c => c.id)).then(ls => { if (on && ls) setLineMap(new Map(ls.filter(l => l.customer_id).map(l => [l.customer_id as string, lineStatusOf(l)]))); }).catch(() => {});
    return () => { on = false; };
  }, [repo, list]);
  // 行のどこを押しても詳細へ（名前のリンクはそのまま＝キーボードでも開ける）。文字を選んでいるときは開かない
  function openRow(e: React.MouseEvent, id: string) {
    if ((e.target as HTMLElement).closest("a,button,input,select,textarea")) return;
    if (window.getSelection()?.toString()) return;
    if (e.metaKey || e.ctrlKey) { window.open(`/customers/${id}`, "_blank"); return; }
    router.push(`/customers/${id}`);
  }
  useEffect(() => { repo.me().then(m => setIsAdmin(!!m && (m.role === "owner" || m.role === "manager"))).catch(() => {}); }, [repo]);
  async function add() { if (!n.name) return; await repo.upsertCustomer({ ...n, name: n.name! }); setN({ name: "" }); setAdding(false); setList(await repo.customers(q, { limit: PAGE })); }
  return (
    <div className="max-w-3xl">
      <div className="flex flex-wrap gap-2 mb-3"><input className="inp flex-1 min-w-0 basis-48" placeholder="名前・カナ・電話で検索" value={q} onChange={e => setQ(e.target.value)} /><button className="btn-primary" onClick={() => setAdding(!adding)}>＋新規</button>{isAdmin && <Link href="/settings/import" className="btn">CSV取り込み</Link>}</div>
      {adding && <div className="card mb-3 grid grid-cols-2 gap-2">
        <input className="inp" placeholder="氏名*" value={n.name || ''} onChange={e => setN({ ...n, name: e.target.value })} />
        <input className="inp" placeholder="フリガナ" value={n.kana || ''} onChange={e => setN({ ...n, kana: e.target.value })} />
        <input className="inp" placeholder="電話" value={n.phone || ''} onChange={e => setN({ ...n, phone: e.target.value })} />
        <input className="inp" placeholder="生年月 1990-04" value={n.birth_month || ''} onChange={e => setN({ ...n, birth_month: e.target.value })} />
        <select className="inp" value={n.source || ''} onChange={e => setN({ ...n, source: e.target.value })}><option value="">流入経路</option><option value="hpb">HPB</option><option value="own">自社</option><option value="line">LINE</option><option value="referral">紹介</option><option value="walkin">通りがかり</option></select>
        <button className="btn-primary" onClick={add}>登録</button>
      </div>}
      <div className="card p-0 overflow-hidden"><table className="w-full"><thead><tr><th className="th">氏名</th><th className="th">電話</th><th className="th">経路</th><th className="th hidden sm:table-cell">登録</th></tr></thead>
        <tbody>{list.map(c => <tr key={c.id} className="hover:bg-emerald-50 cursor-pointer" onClick={e => openRow(e, c.id)} data-testid="customer-row"><td className="td"><span className="inline-flex items-center gap-1.5 flex-wrap"><Link href={`/customers/${c.id}`} className="text-canopy font-semibold">{c.name}</Link><LineMark status={lineMap.get(c.id)} /></span><div className="text-[10px] text-stone-400">{c.kana}</div></td><td className="td whitespace-nowrap">{c.phone}</td><td className="td text-xs">{c.source}</td><td className="td text-xs hidden sm:table-cell">{c.created_at.slice(0, 10)}</td></tr>)}</tbody></table></div>
      {more && <div className="text-center mt-2"><button className="btn" onClick={loadMore}>もっと見る（{list.length}人を表示中）</button></div>}
    </div>
  );
}
