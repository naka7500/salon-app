"use client";
import { Suspense, useEffect, useMemo, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { getRepo, yen, todayStr, hm, PAY_LABEL, staffLabel, type Booking, type Menu, type Product, type Staff, type Customer, type Sale, type PayMethod, type NewSaleInput, type Coupon } from "@/lib/db";
import { couponPrice, couponConditions } from "@/lib/web";

type Line = NewSaleInput['lines'][number];

export default function PosPage() { return <Suspense><Pos /></Suspense>; }

function Pos() {
  const repo = getRepo();
  const sp = useSearchParams(); const router = useRouter();
  const bookingId = sp.get("booking");
  const [menus, setMenus] = useState<Menu[]>([]); const [products, setProducts] = useState<Product[]>([]); const [staff, setStaff] = useState<Staff[]>([]); const [allStaff, setAllStaff] = useState<Staff[]>([]);
  const [booking, setBooking] = useState<Booking|null>(null); const [customer, setCustomer] = useState<Customer|null>(null);
  const [todayBookings, setTodayBookings] = useState<Booking[]>([]); const [customers, setCustomers] = useState<Customer[]>([]);
  const [lines, setLines] = useState<Line[]>([]); const [discount, setDiscount] = useState(0); const [discountReason, setDiscountReason] = useState("");
  const [mainStaff, setMainStaff] = useState(""); const [pays, setPays] = useState<{ method: PayMethod; amount: number }[]>([{ method: 'cash', amount: 0 }]); const [payTouched, setPayTouched] = useState(false);
  const [sales, setSales] = useState<Sale[]>([]); const [done, setDone] = useState<Sale|null>(null); const [err, setErr] = useState("");
  const [coupons, setCoupons] = useState<Coupon[] | null>(null); const [couponId, setCouponId] = useState(""); const [isNewCust, setIsNewCust] = useState<boolean | null>(null);

  useEffect(() => { (async () => {
    const [m, p, s, c, all] = await Promise.all([repo.menus(), repo.products(), repo.staff(), repo.customers(), repo.allStaff().catch(() => [] as Staff[])]);
    setMenus(m); setProducts(p); setStaff(s); setCustomers(c); setAllStaff(all);
    repo.coupons().then(cs => setCoupons(cs ? cs.filter(x => x.active) : null)).catch(() => setCoupons(null));
    setTodayBookings((await repo.bookingsOn(todayStr())).filter(b => !['done','cancelled','block'].includes(b.status)));
    setSales(await repo.salesOn(todayStr()));
    if (bookingId) {
      const b = await repo.booking(bookingId); if (b) {
        setBooking(b); setMainStaff(b.staff_id || s[0]?.id || ""); if (b.coupon_id) setCouponId(b.coupon_id);
        if (b.customer_id) setCustomer((await repo.customer(b.customer_id)) || null);
        const ls = b.menu_ids.map(id => m.find(x => x.id === id)).filter(Boolean).map(mm => ({ kind: mm!.category === 'option' ? 'option' : 'menu', menu_id: mm!.id, name: mm!.name, unit_price: mm!.price, qty: 1, tax_rate: mm!.tax_rate, staff_id: b.staff_id } as Line));
        // 指名の予約：担当の指名料を1行入れる（スタッフ設定の「指名料」）
        const who = all.find(x => x.id === b.staff_id) || s.find(x => x.id === b.staff_id);
        if (b.nominated && who && (who.nomination_fee || 0) > 0) ls.push({ kind: 'fee', menu_id: null, product_id: null, name: `指名料（${who.name}）`, unit_price: who.nomination_fee || 0, qty: 1, tax_rate: 0.1, staff_id: b.staff_id } as Line);
        setLines(ls);
      }
    } else setMainStaff(s[0]?.id || "");
  })(); }, [repo, bookingId]);

  const subtotal = useMemo(() => lines.reduce((a, l) => a + l.unit_price * l.qty, 0), [lines]);
  // クーポン：対象メニューの最初の1行に適用（1回の来店で1つ）
  const coupon = coupons?.find(c => c.id === couponId) || null;
  const couponLine = coupon ? lines.find(l => l.menu_id && (coupon.menu_ids.length ? coupon.menu_ids.includes(l.menu_id) : menus.find(m => m.id === l.menu_id)?.category === 'technical')) : undefined;
  const couponDiscount = coupon && couponLine ? Math.max(0, couponLine.unit_price - couponPrice(coupon.kind, coupon.value, couponLine.unit_price)) : 0;
  useEffect(() => { if (!coupon) return; void Promise.resolve().then(() => { setDiscount(couponDiscount); setDiscountReason(coupon.name); }); }, [coupon, couponDiscount]);
  useEffect(() => { if (!customer) { void Promise.resolve().then(() => setIsNewCust(null)); return; } repo.firstVisits([customer.id]).then(fv => setIsNewCust(!fv[customer.id])).catch(() => setIsNewCust(null)); }, [repo, customer]);
  const couponWarn = coupon && isNewCust !== null && ((coupon.target === 'new' && !isNewCust) || (coupon.target === 'repeat' && isNewCust)) ? `このお客様は${isNewCust ? '新規' : '再来'}です（クーポンは${coupon.target === 'new' ? '新規' : '再来'}限定）` : '';
  const total = subtotal - discount;
  const paid = pays.reduce((a, p) => a + p.amount, 0);
  const change = paid - total;
  useEffect(() => { if (pays.length === 1 && !payTouched) setPays([{ method: pays[0].method, amount: total }]); }, [total]); // eslint-disable-line react-hooks/exhaustive-deps

  function add(kind: 'menu'|'product', item: Menu|Product) {
    const isMenu = kind === 'menu';
    setLines([...lines, { kind: isMenu ? ((item as Menu).category === 'option' ? 'option' : 'menu') : 'product', menu_id: isMenu ? item.id : null, product_id: isMenu ? null : item.id, name: item.name, unit_price: item.price, qty: 1, tax_rate: item.tax_rate, staff_id: mainStaff }]);
  }
  async function confirm() {
    setErr("");
    try {
      if (!lines.length) throw new Error("明細がありません");
      if (paid < total) throw new Error(`お預かりが ${yen(total - paid)} 足りません`);
      const s = await repo.createSale({ booking_id: booking?.id || null, customer_id: customer?.id || null, main_staff_id: mainStaff || null, discount, discount_reason: discountReason, lines, payments: pays.filter(p => p.amount !== 0), coupon_id: coupon && couponDiscount > 0 ? coupon.id : null });
      setDone(s); setSales(await repo.salesOn(todayStr()));
    } catch (e) { setErr((e as Error).message); }
  }
  function reset() { setDone(null); setBooking(null); setCustomer(null); setLines([]); setDiscount(0); setDiscountReason(""); setCouponId(""); setPays([{ method: 'cash', amount: 0 }]); setPayTouched(false); router.replace("/pos"); }

  if (done) return (
    <div className="card max-w-md mx-auto text-center">
      <div className="text-emerald-700 font-bold text-lg mb-1">お会計が完了しました</div>
      <div className="text-sm text-stone-500 mb-3">伝票 {done.sale_no}</div>
      <div className="text-3xl font-bold mb-1">{yen(done.total)}</div>
      <div className="text-sm text-stone-600 mb-4">お預かり {yen(done.payments.reduce((a,p)=>a+p.amount,0))}／お釣り {yen(done.payments.reduce((a,p)=>a+p.amount,0) - done.total)}</div>
      <div className="text-xs text-stone-500 mb-4">※次回予約のご案内はこの前に（最初のカウンセリングで）。ここはお釣りを渡した後の「システムの確認」だけ。</div>
      <div className="flex flex-wrap gap-2 justify-center">
        {done.customer_id && <button className="btn" onClick={() => router.push(`/customers/${done.customer_id}?karte=1${done.booking_id ? `&booking=${done.booking_id}` : ''}`)}>カルテを書く{booking?.intake?.length ? '（問診を貼る）' : ''}</button>}
        <button className="btn" onClick={() => router.push('/bookings')}>台帳で次回予約を入れる</button>
        <button className="btn-primary" onClick={reset}>次のお会計</button>
      </div>
    </div>
  );

  return (
    <div className="grid lg:grid-cols-[1fr_380px] gap-4">
      <div>
        {!booking && (
          <div className="card mb-3">
            <div className="lbl">今日の未会計の予約から選ぶ</div>
            <div className="flex flex-wrap gap-1">
              {todayBookings.length === 0 && <span className="text-sm text-stone-400">未会計の予約はありません。下のメニューから直接作れます（来店・電話分）</span>}
              {todayBookings.map(b => <button key={b.id} className="btn text-xs" onClick={() => router.replace(`/pos?booking=${b.id}`)}>{hm(b.start_at)} {b.customer_name || customers.find(c => c.id === b.customer_id)?.name}</button>)}
            </div>
          </div>
        )}
        <div className="card mb-3">
          <div className="lbl">メニュー</div>
          <div className="flex flex-wrap gap-1 mb-2">{menus.map(m => <button key={m.id} className="btn text-xs" onClick={() => add('menu', m)}>{m.name} {m.price.toLocaleString()}</button>)}</div>
          <div className="lbl">店販（在庫）</div>
          <div className="flex flex-wrap gap-1">{products.map(p => <button key={p.id} className={`btn text-xs ${p.stock <= p.reorder_point ? 'border-rose-400' : ''}`} onClick={() => add('product', p)}>{p.name} {p.price.toLocaleString()} <span className="text-stone-400">在庫{p.stock}</span></button>)}</div>
        </div>
        <div className="card">
          <div className="lbl">今日の伝票（{sales.filter(s => s.status === 'confirmed').length}件・{yen(sales.reduce((a, s) => a + s.total, 0))}）</div>
          <table className="w-full"><thead><tr><th className="th">時刻</th><th className="th">伝票</th><th className="th">お客様</th><th className="th text-right">金額</th><th className="th">支払</th><th className="th"></th></tr></thead>
            <tbody>{sales.map(s => <tr key={s.id} className={s.status === 'voided' ? 'line-through text-stone-400' : ''}>
              <td className="td">{hm(s.sold_at)}</td><td className="td">{s.sale_no}</td><td className="td">{customers.find(c => c.id === s.customer_id)?.name || '-'}</td><td className="td text-right">{yen(s.total)}</td>
              <td className="td text-xs">{s.payments.map(p => PAY_LABEL[p.method]).join('+')}</td>
              <td className="td">{s.status === 'confirmed' && !s.closed_on && <button className="btn text-xs text-rose-600" onClick={async () => { const r = prompt('赤伝の理由'); if (r) { try { await repo.reverseSale(s.id, r); } catch (e) { alert((e as Error).message); } setSales(await repo.salesOn(todayStr())); } }}>赤伝</button>}</td>
            </tr>)}</tbody></table>
        </div>
      </div>

      <div className="card h-fit lg:sticky lg:top-3">
        <div className="flex items-center justify-between mb-2">
          <div><div className="font-bold">{customer?.name || (booking ? '(顧客未登録)' : 'お客様未選択')}</div>{booking && <div className="text-xs text-stone-500">{hm(booking.start_at)} の予約</div>}</div>
          {!booking && <select className="inp text-xs" value={customer?.id || ''} onChange={e => setCustomer(customers.find(c => c.id === e.target.value) || null)}><option value="">顧客を選ぶ</option>{customers.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select>}
        </div>
        <div className="mb-2"><label className="lbl">主担当</label><select className="inp w-full" value={mainStaff} onChange={e => setMainStaff(e.target.value)}>{staff.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}{mainStaff && !staff.some(s => s.id === mainStaff) && <option value={mainStaff}>{staffLabel(allStaff.find(s => s.id === mainStaff))}</option>}</select></div>
        <table className="w-full mb-2"><tbody>
          {lines.map((l, i) => <tr key={i}><td className="td">{l.name}<div className="text-[10px] text-stone-400">担当 {(allStaff.find(s => s.id === l.staff_id) || staff.find(s => s.id === l.staff_id))?.name || '-'}</div></td>
            <td className="td w-16"><input type="number" className="inp w-14 text-right" value={l.qty} min={1} onChange={e => setLines(lines.map((x, j) => j === i ? { ...x, qty: +e.target.value } : x))} /></td>
            <td className="td text-right whitespace-nowrap">{yen(l.unit_price * l.qty)}</td>
            <td className="td"><button className="text-rose-500 text-xs" onClick={() => setLines(lines.filter((_, j) => j !== i))}>×</button></td></tr>)}
          {lines.length === 0 && <tr><td className="td text-stone-400 text-sm" colSpan={4}>左のボタンで明細を追加</td></tr>}
        </tbody></table>
        <div className="flex items-center gap-2 mb-1 text-sm"><span>小計</span><span className="ml-auto">{yen(subtotal)}</span></div>
        {coupons && coupons.length > 0 && <div className="mb-1">
          <div className="flex items-center gap-2 text-sm"><span>クーポン</span>
            <select className="inp flex-1 text-xs" value={couponId} onChange={e => { setCouponId(e.target.value); if (!e.target.value) { setDiscount(0); setDiscountReason(""); } }} aria-label="クーポンを選ぶ">
              <option value="">使わない</option>{coupons.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select></div>
          {coupon && <div className="text-[11px] mt-0.5 text-stone-600">{couponLine ? `${couponLine.name} に適用：−${yen(couponDiscount)}` : '対象のメニューが明細にありません'}{couponConditions(coupon).length ? `（${couponConditions(coupon).join('・')}）` : ''}</div>}
          {couponWarn && <div className="text-[11px] mt-0.5 text-amber-800 bg-amber-50 border border-amber-300 rounded px-1.5 py-0.5">⚠ {couponWarn}</div>}
        </div>}
        <div className="flex items-center gap-2 mb-1 text-sm"><span>値引</span><input type="number" className="inp w-24 text-right ml-auto" value={discount} readOnly={!!coupon} onChange={e => setDiscount(+e.target.value)} /></div>
        {discount > 0 && <input className="inp w-full mb-1 text-xs" placeholder="値引の理由（クーポン名など）" value={discountReason} readOnly={!!coupon} onChange={e => setDiscountReason(e.target.value)} />}
        <div className="flex items-center gap-2 mb-2 text-lg font-bold border-t pt-2"><span>合計（税込）</span><span className="ml-auto">{yen(total)}</span></div>
        <div className="lbl">支払（併用可）</div>
        {pays.map((p, i) => <div key={i} className="flex gap-1 mb-1">
          <select className="inp" value={p.method} onChange={e => setPays(pays.map((x, j) => j === i ? { ...x, method: e.target.value as PayMethod } : x))}>{Object.entries(PAY_LABEL).filter(([k]) => k !== 'voucher').map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
          <input type="number" className="inp flex-1 text-right" value={p.amount} onChange={e => { setPayTouched(true); setPays(pays.map((x, j) => j === i ? { ...x, amount: +e.target.value } : x)); }} />
          {pays.length > 1 && <button className="text-rose-500" onClick={() => setPays(pays.filter((_, j) => j !== i))}>×</button>}
        </div>)}
        <div className="flex gap-1 mb-2"><button className="btn text-xs" onClick={() => { setPayTouched(true); setPays([...pays, { method: 'card', amount: Math.max(0, total - paid) }]); }}>＋支払を追加</button><button className="btn text-xs" onClick={() => { setPayTouched(false); setPays([{ method: 'cash', amount: total }]); }}>現金ちょうど</button></div>
        <div className="text-sm mb-2">お預かり {yen(paid)}　<span className={change < 0 ? 'text-rose-600' : ''}>お釣り {yen(Math.max(0, change))}</span></div>
        {err && <div className="text-rose-600 text-sm mb-2">{err}</div>}
        <button className="btn-primary w-full" disabled={!lines.length} onClick={confirm}>会計を確定する</button>
      </div>
    </div>
  );
}
