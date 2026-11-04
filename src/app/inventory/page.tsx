"use client";
import { useEffect, useState } from "react";
import { getRepo, yen, type Product, type InventoryMove } from "@/lib/db";

export default function InventoryPage() {
  const repo = getRepo();
  const [products, setProducts] = useState<Product[]>([]); const [sel, setSel] = useState<Product|null>(null); const [moves, setMoves] = useState<InventoryMove[]>([]);
  const [qty, setQty] = useState(1); const [reason, setReason] = useState<InventoryMove['reason']>('purchase');
  useEffect(() => { repo.products().then(setProducts); }, [repo]);
  useEffect(() => { if (sel) repo.inventoryMoves(sel.id).then(setMoves); }, [sel, repo]);
  async function apply() { if (!sel) return; const p = await repo.adjustStock(sel.id, reason === 'sale' ? -Math.abs(qty) : qty, reason); setProducts(await repo.products()); setSel(p); setMoves(await repo.inventoryMoves(p.id)); }
  const R: Record<string, string> = { sale: '販売', purchase: '入荷', adjust: '調整', return: '返品', stocktake: '棚卸' };
  return (
    <div className="grid md:grid-cols-[1fr_360px] gap-3">
      <div className="card p-0 overflow-hidden"><table className="w-full"><thead><tr><th className="th">商品</th><th className="th text-right">売価</th><th className="th text-right">原価</th><th className="th text-right">在庫</th><th className="th text-right">発注点</th></tr></thead>
        <tbody>{products.map(p => <tr key={p.id} className={`cursor-pointer hover:bg-emerald-50 ${sel?.id === p.id ? 'bg-emerald-50' : ''}`} onClick={() => setSel(p)}>
          <td className="td">{p.name}{p.stock <= p.reorder_point && <span className="ml-1 text-[10px] bg-rose-100 text-rose-700 px-1 rounded">要発注</span>}</td><td className="td text-right">{yen(p.price)}</td><td className="td text-right">{yen(p.cost)}</td><td className="td text-right font-semibold">{p.stock}</td><td className="td text-right">{p.reorder_point}</td></tr>)}</tbody></table>
        <div className="text-xs text-stone-500 p-2">売上で自動的に減ります。在庫金額（原価）：{yen(products.reduce((a, p) => a + p.cost * p.stock, 0))}</div>
      </div>
      <div className="card h-fit">
        {sel ? <>
          <div className="font-bold mb-2">{sel.name}（在庫 {sel.stock}）</div>
          <div className="flex gap-1 mb-2"><select className="inp" value={reason} onChange={e => setReason(e.target.value as InventoryMove['reason'])}>{['purchase','adjust','return','stocktake'].map(r => <option key={r} value={r}>{R[r]}</option>)}</select><input type="number" className="inp w-20 text-right" value={qty} onChange={e => setQty(+e.target.value)} /><button className="btn-primary" onClick={apply}>反映</button></div>
          <div className="text-[10px] text-stone-400 mb-2">入荷は＋、調整はマイナスも可（例：破損 -1）。棚卸は差分を入れる</div>
          <div className="lbl">履歴</div>{moves.map(m => <div key={m.id} className="text-xs border-t py-1 flex"><span>{m.moved_at.slice(0, 16).replace('T', ' ')}</span><span className="ml-2">{R[m.reason]}</span><span className={`ml-auto ${m.qty < 0 ? 'text-rose-600' : 'text-emerald-700'}`}>{m.qty > 0 ? '+' : ''}{m.qty}</span></div>)}
        </> : <div className="text-sm text-stone-400">左の商品を選ぶと入荷・調整ができます</div>}
      </div>
    </div>
  );
}
