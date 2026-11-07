"use client";
import { Suspense, useEffect, useMemo, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { getRepo, yen, todayStr, hm, PAY_LABEL, type Booking, type Menu, type Product, type Staff, type Customer, type Sale, type PayMethod, type NewSaleInput, type Coupon, type Lane, type Store } from "@/lib/db";
import { defaultMain, parseMain, defaultLineStaff, lastProductStaff, missingLineStaff, lineStaffOptions, mainLabel, FREE_LABEL } from "@/lib/saleStaff";
import { couponPrice, couponConditions } from "@/lib/web";
import { pairLines, pairModeChoices, validateSale, newClientKey } from "@/lib/pos";
import CustomerSearch from "@/components/CustomerSearch";
import LineLinkQr from "@/components/LineLinkQr";
import { localDate } from "@/lib/schedule";

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
  // 主担当：'staff:<id>'（スタッフ）／'lane:<id>'（受付枠「1名様でのご予約」など）／'free'（フリー）
  const [mainPick, setMainPick] = useState(""); const [lanes, setLanes] = useState<Lane[]>([]); const [laneOk, setLaneOk] = useState(false); const [store, setStore] = useState<Store|null>(null);
  const [custSales, setCustSales] = useState<Sale[]>([]); const [staffErr, setStaffErr] = useState<number[]>([]); const [pays, setPays] = useState<{ method: PayMethod; amount: number }[]>([{ method: 'cash', amount: 0 }]); const [payTouched, setPayTouched] = useState(false);
  const [sales, setSales] = useState<Sale[]>([]); const [done, setDone] = useState<Sale|null>(null); const [err, setErr] = useState("");
  const [coupons, setCoupons] = useState<Coupon[] | null>(null); const [couponId, setCouponId] = useState(""); const [isNewCust, setIsNewCust] = useState<boolean | null>(null);
  // ペア：相手の予約行と、伝票を1枚にまとめるか2枚に分けるか
  const [group, setGroup] = useState<Booking[]>([]); const [pairMode, setPairMode] = useState<'one'|'split'>('one');
  // まだ会計していない相手（1枚にまとめるときにいっしょに会計済みにする）／もう会計済みの相手の数
  const pc = booking ? pairModeChoices(booking, group) : { isPair: false, othersPaid: 0, othersUnpaid: [] as Booking[] };
  const partners = pc.othersUnpaid;
  // 会計1回ぶんの合言葉（二度押し・通信のやり直しで伝票を二重にしない）／処理中
  const [clientKey, setClientKey] = useState(newClientKey); const [busy, setBusy] = useState(false);

  useEffect(() => { (async () => {
    const [m, p, s, all, laneList, caps, st] = await Promise.all([repo.menus(), repo.products(), repo.staff(), repo.allStaff().catch(() => [] as Staff[]), repo.lanes().catch(() => [] as Lane[]), repo.capabilities(), repo.store().catch(() => null)]);
    setMenus(m); setProducts(p); setStaff(s); setAllStaff(all); setLanes(laneList); setLaneOk(!!caps.v13); setStore(st);
    repo.coupons().then(cs => setCoupons(cs ? cs.filter(x => x.active) : null)).catch(() => setCoupons(null));
    const tb = (await repo.bookingsOn(todayStr())).filter(b => !['done','cancelled','block'].includes(b.status));
    const ts = await repo.salesOn(todayStr());
    setTodayBookings(tb); setSales(ts);
    // 名前の表示に使うお客様だけ取る（全員は取らない：何千人でも遅くならない）
    const ids = [...new Set([...tb.map(b => b.customer_id), ...ts.map(x => x.customer_id)].filter(Boolean) as string[])];
    if (ids.length) repo.customersByIds(ids).then(setCustomers).catch(() => {});
    if (bookingId) {
      const b = await repo.booking(bookingId); if (b) {
        setBooking(b); setMainPick(defaultMain(b, laneList, !!caps.v13, s[0]?.id)); if (b.coupon_id) setCouponId(b.coupon_id);
        if (b.customer_id) setCustomer((await repo.customer(b.customer_id)) || null);
        // 同じペアの予約（会計済みも含める：1人目が先に会計しても2人目の金額を正しく出すため）
        const grp = b.pair_group ? (await repo.bookingsOn(localDate(b.start_at))).filter(x => x.pair_group === b.pair_group && x.status !== 'cancelled') : [b];
        setGroup(grp);
        const mode0 = pairModeChoices(b, grp).othersPaid > 0 ? 'split' : 'one'; setPairMode(mode0);
        const ls = pairLines(b, grp, mode0, m, all.length ? all : s);
        // 指名の予約：担当の指名料を1行入れる（スタッフ設定の「指名料」）
        const who = all.find(x => x.id === b.staff_id) || s.find(x => x.id === b.staff_id);
        if (b.nominated && who && (who.nomination_fee || 0) > 0) ls.push({ kind: 'fee', menu_id: null, product_id: null, name: `指名料（${who.name}）`, unit_price: who.nomination_fee || 0, qty: 1, tax_rate: 0.1, staff_id: b.staff_id } as Line);
        setLines(ls);
      }
    } else setMainPick(s[0] ? `staff:${s[0].id}` : "");
  })(); }, [repo, bookingId]);
  // お客様の過去の伝票（店販の担当の候補：前回の店販の担当）
  useEffect(() => { if (!customer) { void Promise.resolve().then(() => setCustSales([])); return; } repo.salesOfCustomer(customer.id).then(setCustSales).catch(() => setCustSales([])); }, [repo, customer]);
  const staffById = (id?: string|null) => allStaff.find(x => x.id === id) || staff.find(x => x.id === id);
  const nameOf = (id?: string|null) => staffById(id)?.name || "";
  // 施術担当（技術の行の初期値）：予約の担当、無ければ主担当がスタッフならその人
  const serviceStaff = booking?.staff_id || (mainPick.startsWith("staff:") ? mainPick.slice(6) : null);
  const prevProduct = lastProductStaff(custSales, customer?.id);
  const opts = lineStaffOptions(allStaff.length ? allStaff : staff, store?.id);
  const setLineStaff = (i: number, id: string) => { setLines(lines.map((x, j) => j === i ? { ...x, staff_id: id || null } : x)); setStaffErr(e => e.filter(k => k !== i)); setErr(""); };

  const subtotal = useMemo(() => lines.reduce((a, l) => a + l.unit_price * l.qty, 0), [lines]);
  // クーポン：対象メニューの最初の1行に適用（1回の来店で1つ）
  const coupon = coupons?.find(c => c.id === couponId) || null;
  const couponLine = coupon ? lines.find(l => l.menu_id && (coupon.menu_ids.length ? coupon.menu_ids.includes(l.menu_id) : menus.find(m => m.id === l.menu_id)?.category === 'technical')) : undefined;
  // ペアを1伝票にしたときは同じメニューの行（2人分）を合わせた金額にクーポンをかける
  const couponBase = couponLine ? lines.filter(l => l.menu_id === couponLine.menu_id && (l.kind === 'menu')).reduce((a, l) => a + l.unit_price * l.qty, 0) || couponLine.unit_price : 0;
  const couponDiscount = coupon && couponLine ? Math.max(0, couponBase - couponPrice(coupon.kind, coupon.value, couponBase)) : 0;
  useEffect(() => { if (!coupon) return; void Promise.resolve().then(() => { setDiscount(couponDiscount); setDiscountReason(coupon.name); }); }, [coupon, couponDiscount]);
  useEffect(() => { if (!customer) { void Promise.resolve().then(() => setIsNewCust(null)); return; } repo.firstVisits([customer.id]).then(fv => setIsNewCust(!fv[customer.id])).catch(() => setIsNewCust(null)); }, [repo, customer]);
  const couponWarn = coupon && isNewCust !== null && ((coupon.target === 'new' && !isNewCust) || (coupon.target === 'repeat' && isNewCust)) ? `このお客様は${isNewCust ? '新規' : '再来'}です（クーポンは${coupon.target === 'new' ? '新規' : '再来'}限定）` : '';
  const total = subtotal - discount;
  const paid = pays.reduce((a, p) => a + p.amount, 0);
  const change = paid - total;
  useEffect(() => { if (pays.length === 1 && !payTouched) void Promise.resolve().then(() => setPays(p => (p.length === 1 ? [{ method: p[0].method, amount: total }] : p))); }, [total]); // eslint-disable-line react-hooks/exhaustive-deps

  function add(kind: 'menu'|'product', item: Menu|Product) {
    const isMenu = kind === 'menu';
    const lk = isMenu ? ((item as Menu).category === 'option' ? 'option' : 'menu') : 'product';
    // 技術＝施術担当／店販＝空（おすすめした人を選ぶまで確定できない）
    setLines([...lines, { kind: lk, menu_id: isMenu ? item.id : null, product_id: isMenu ? null : item.id, name: item.name, unit_price: item.price, qty: 1, tax_rate: item.tax_rate, staff_id: defaultLineStaff(lk, serviceStaff) }]);
  }
  async function confirm() {
    if (busy) return;
    setErr(""); setBusy(true);
    try {
      const payments = pays.filter(p => p.amount !== 0);
      const bad = validateSale({ lines, discount, payments });
      if (bad) throw new Error(bad);
      const miss = missingLineStaff(lines);
      if (miss.length) { setStaffErr(miss); throw new Error(`明細担当を選んでください（${miss.map(i => lines[i].name).join("・")}）。店販は、最初におすすめした人を選びます`); }
      const main = parseMain(mainPick, lanes);
      const s = await repo.createSale({ booking_id: booking?.id || null, customer_id: customer?.id || null, ...main, discount, discount_reason: discountReason, lines, payments, coupon_id: coupon && couponDiscount > 0 ? coupon.id : null,
        client_key: clientKey, partner_booking_ids: pairMode === 'one' ? partners.map(x => x.id) : [] });
      setDone(s); setSales(await repo.salesOn(todayStr()));
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }
  function switchPair(mode: 'one'|'split') {
    if (!booking) return; setPairMode(mode);
    const fee = lines.filter(l => l.kind === 'fee' || l.kind === 'product');
    setLines([...pairLines(booking, group, mode, menus, allStaff.length ? allStaff : staff), ...fee]);
  }
  function reset() { setClientKey(newClientKey()); setStaffErr([]); setCustSales([]); setGroup([]); setPairMode('one'); setDone(null); setBooking(null); setCustomer(null); setLines([]); setDiscount(0); setDiscountReason(""); setCouponId(""); setPays([{ method: 'cash', amount: 0 }]); setPayTouched(false); router.replace("/pos"); }

  if (done) return (
    <div className="card max-w-md mx-auto text-center">
      <div className="text-emerald-700 font-bold text-lg mb-1">お会計が完了しました</div>
      <div className="text-sm text-stone-500 mb-3">伝票 {done.sale_no}／主担当 {mainLabel(done, allStaff.length ? allStaff : staff)}</div>
      <div className="text-3xl font-bold mb-1">{yen(done.total)}</div>
      <div className="text-sm text-stone-600 mb-4">お預かり {yen(done.payments.reduce((a,p)=>a+p.amount,0))}／お釣り {yen(done.payments.reduce((a,p)=>a+p.amount,0) - done.total)}</div>
      <div className="text-xs text-stone-500 mb-4">※次回予約のご案内はこの前に（最初のカウンセリングで）。ここはお釣りを渡した後の「システムの確認」だけ。</div>
      <div className="flex flex-wrap gap-2 justify-center">
        {done.customer_id && <LineLinkQr customerId={done.customer_id} customerName={customer?.name} />}
        {done.customer_id && <button className="btn" onClick={() => router.push(`/customers/${done.customer_id}?karte=1${done.booking_id ? `&booking=${done.booking_id}` : ''}`)}>カルテを書く{booking?.intake?.length ? '（問診を貼る）' : ''}</button>}
        <button className="btn" onClick={() => router.push('/bookings')}>台帳で次回予約を入れる</button>
        <button className="btn-primary" onClick={reset}>次のお会計</button>
      </div>
    </div>
  );

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_380px] gap-4">
      <div className="min-w-0">
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
          <div className="flex flex-wrap gap-1 mb-2">{menus.map(m => <button key={m.id} className="btn text-xs whitespace-normal text-left max-w-full" onClick={() => add('menu', m)}>{m.name} {m.price.toLocaleString()}{m.coupon_only && <span className="ml-1 text-[10px] text-stone-500">クーポン専用</span>}</button>)}</div>
          <div className="lbl">店販（在庫）</div>
          <div className="flex flex-wrap gap-1">{products.map(p => <button key={p.id} className={`btn text-xs whitespace-normal text-left max-w-full ${p.stock <= p.reorder_point ? 'border-rose-400' : ''}`} onClick={() => add('product', p)}>{p.name} {p.price.toLocaleString()} <span className="text-stone-400">在庫{p.stock}</span></button>)}</div>
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
          <div><div className="font-bold">{customer?.name || (booking ? '(顧客未登録)' : 'お客様未選択')}</div>{booking && <div className="text-xs text-stone-500">{hm(booking.start_at)} の予約</div>}
            {customer && <div className="mt-1"><LineLinkQr customerId={customer.id} customerName={customer.name} compact /></div>}</div>
          {!booking && <CustomerSearch value={customer} onPick={setCustomer} compact />}
        </div>
        {booking?.status === 'done' && <div className="mb-2 rounded border border-rose-300 bg-rose-50 p-2 text-sm text-rose-800" data-testid="already-paid">この予約は会計済みです（伝票の一覧を確認してください）。もう一度会計はできません。</div>}
        {booking && pc.isPair && (
          <div className="mb-2 rounded border border-amber-300 bg-amber-50 p-2 text-sm" data-testid="pair-mode">
            <div className="font-semibold text-amber-900 mb-1">ペア（2名様）のお会計</div>
            <div className="flex gap-1" role="radiogroup" aria-label="ペアの伝票の分け方">
              {partners.length > 0 && <button role="radio" aria-checked={pairMode === 'one'} className={`btn text-xs ${pairMode === 'one' ? '!bg-canopy !text-white' : ''}`} onClick={() => switchPair('one')}>1枚の伝票にまとめる</button>}
              <button role="radio" aria-checked={pairMode === 'split'} className={`btn text-xs ${pairMode === 'split' ? '!bg-canopy !text-white' : ''}`} onClick={() => switchPair('split')}>2枚に分ける（この方の分だけ）</button>
            </div>
            <div className="text-[11px] text-stone-600 mt-1">売上は担当2人に半分ずつ入ります（{(group.length > 1 ? group : [booking, ...partners]).map(p => nameOf(p.staff_id) || '担当なし').join('・')}）。{pc.othersPaid > 0 ? 'もう1名様は会計済みです。この方の分（残り）だけをお会計します。' : pairMode === 'split' ? 'もう1名様は、会計の「今日の未会計の予約」から別にお会計してください。' : ''}</div>
          </div>
        )}
        <div className="mb-2">
          <label className="lbl" htmlFor="main-pick">主担当<span className="text-ink-mute">（伝票の顔。売上は下の「明細担当」で数えます）</span></label>
          <select id="main-pick" data-testid="main-pick" className="inp w-full" value={mainPick} onChange={e => setMainPick(e.target.value)}>
            {!mainPick && <option value="">—</option>}
            {laneOk && lanes.length > 0 && <optgroup label="受付枠（指名なし）">{lanes.map(l => <option key={l.id} value={`lane:${l.id}`}>{l.name}</option>)}<option value="free">{FREE_LABEL}</option></optgroup>}
            <optgroup label="スタッフ">{staff.map(s => <option key={s.id} value={`staff:${s.id}`}>{s.name}</option>)}
              {mainPick.startsWith("staff:") && !staff.some(s => `staff:${s.id}` === mainPick) && <option value={mainPick}>{nameOf(mainPick.slice(6)) || "（ほかの担当）"}</option>}</optgroup>
          </select>
          {!laneOk && lanes.length > 0 && <div className="text-[11px] text-ink-mute mt-0.5">「1名様でのご予約」などの受付枠を主担当にするのは準備中です（DB更新 0013 の後に選べます）</div>}
        </div>
        <table className="w-full mb-2 table-fixed" data-testid="sale-lines"><colgroup><col /><col className="w-12" /><col className="w-[4.75rem]" /><col className="w-6" /></colgroup><tbody>
          {lines.map((l, i) => { const bad = staffErr.includes(i); return <tr key={i} data-testid={`line-${i}`}>
            <td className="td">
              <div className="flex items-center gap-1"><span className={`px-1 rounded text-[10px] ${l.kind === "product" ? "bg-sky-100 text-sky-800" : l.kind === "option" ? "bg-violet-100 text-violet-800" : "bg-moss text-canopy-deep"}`}>{l.kind === "product" ? "店販" : l.kind === "option" ? "OP" : l.kind === "fee" ? "指名料" : "技術"}</span><span>{l.name}</span></div>
              <div className="flex items-center gap-1 mt-1">
                <span className="text-[11px] text-ink-soft whitespace-nowrap">明細担当</span>
                <select aria-label={`${l.name} の明細担当`} data-testid={`line-staff-${i}`} className={`inp !min-h-8 !py-0.5 text-xs flex-1 min-w-0 ${bad ? "!border-danger ring-2 ring-danger/20" : ""}`} value={l.staff_id || ""} onChange={e => setLineStaff(i, e.target.value)}>
                  <option value="">{l.kind === "product" ? "おすすめした人を選ぶ" : "選んでください"}</option>
                  <optgroup label="この店舗">{opts.here.map(s => <option key={s.id} value={s.id}>{s.name}{s.show_on_ledger === false ? "（台帳に非表示）" : ""}</option>)}</optgroup>
                  {opts.other.length > 0 && <optgroup label="ほかの店舗（ヘルプ）">{opts.other.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</optgroup>}
                  {l.staff_id && !opts.here.some(s => s.id === l.staff_id) && !opts.other.some(s => s.id === l.staff_id) && <option value={l.staff_id}>{nameOf(l.staff_id) || "—"}（退職）</option>}
                </select>
              </div>
              {l.kind === "product" && !l.staff_id && <div className="flex flex-wrap gap-1 mt-1" data-testid={`line-staff-hint-${i}`}>
                {prevProduct && <button type="button" className="chip bg-sun-soft text-[#7a4f12] border border-[#ecd3a6]" onClick={() => setLineStaff(i, prevProduct)}>前回の店販：{nameOf(prevProduct)}</button>}
                {serviceStaff && serviceStaff !== prevProduct && <button type="button" className="chip bg-moss text-canopy-deep border border-line" onClick={() => setLineStaff(i, serviceStaff)}>施術：{nameOf(serviceStaff)}</button>}
              </div>}
            </td>
            <td className="td !px-1 w-12 align-top"><input type="number" className="inp !px-1 w-11 text-right" value={l.qty} min={1} onChange={e => setLines(lines.map((x, j) => j === i ? { ...x, qty: Math.max(1, Math.floor(+e.target.value) || 1) } : x))} aria-label={`${l.name} の数量`} /></td>
            <td className="td !px-1 text-right whitespace-nowrap align-top text-sm">{yen(l.unit_price * l.qty)}</td>
            <td className="td !px-0.5 align-top"><button className="text-rose-500 text-xs min-h-8 px-1" aria-label={`${l.name} を消す`} onClick={() => { setLines(lines.filter((_, j) => j !== i)); setStaffErr([]); }}>×</button></td></tr>; })}
          {lines.length === 0 && <tr><td className="td text-stone-400 text-sm" colSpan={4}>左のボタンで明細を追加</td></tr>}
        </tbody></table>
        <div className="flex items-center gap-2 mb-1 text-sm"><span>小計</span><span className="ml-auto">{yen(subtotal)}</span></div>
        {coupons && coupons.length > 0 && <div className="mb-1">
          <div className="flex items-center gap-2 text-sm"><span className="whitespace-nowrap">クーポン</span>
            <select className="inp flex-1 min-w-0 text-xs" value={couponId} onChange={e => { setCouponId(e.target.value); if (!e.target.value) { setDiscount(0); setDiscountReason(""); } }} aria-label="クーポンを選ぶ">
              <option value="">使わない</option>{coupons.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select></div>
          {coupon && <div className="text-[11px] mt-0.5 text-stone-600">{couponLine ? `${couponLine.name} に適用：−${yen(couponDiscount)}` : '対象のメニューが明細にありません'}{couponConditions(coupon).length ? `（${couponConditions(coupon).join('・')}）` : ''}</div>}
          {couponWarn && <div className="text-[11px] mt-0.5 text-amber-800 bg-amber-50 border border-amber-300 rounded px-1.5 py-0.5">⚠ {couponWarn}</div>}
        </div>}
        <div className="flex items-center gap-2 mb-1 text-sm"><span>値引</span><input type="number" min={0} max={subtotal} className="inp w-24 text-right ml-auto" value={discount} readOnly={!!coupon} onChange={e => setDiscount(Math.min(subtotal, Math.max(0, Math.floor(+e.target.value) || 0)))} aria-label="値引" /></div>
        {discount > 0 && <input className="inp w-full mb-1 text-xs" placeholder="値引の理由（クーポン名など）" value={discountReason} readOnly={!!coupon} onChange={e => setDiscountReason(e.target.value)} />}
        <div className="flex items-center gap-2 mb-2 text-lg font-bold border-t pt-2"><span>合計（税込）</span><span className="ml-auto">{yen(total)}</span></div>
        <div className="lbl">支払（併用可）</div>
        {pays.map((p, i) => <div key={i} className="flex gap-1 mb-1">
          <select className="inp" value={p.method} onChange={e => setPays(pays.map((x, j) => j === i ? { ...x, method: e.target.value as PayMethod } : x))}>{Object.entries(PAY_LABEL).filter(([k]) => k !== 'voucher').map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
          <input type="number" min={0} className="inp flex-1 min-w-0 text-right" value={p.amount} onChange={e => { setPayTouched(true); setPays(pays.map((x, j) => j === i ? { ...x, amount: Math.max(0, Math.floor(+e.target.value) || 0) } : x)); }} aria-label="支払の金額" />
          {pays.length > 1 && <button className="text-rose-500 min-w-11 min-h-11" aria-label={`${PAY_LABEL[p.method]}の支払を消す`} onClick={() => setPays(pays.filter((_, j) => j !== i))}>×</button>}
        </div>)}
        <div className="flex gap-1 mb-2"><button className="btn text-xs" onClick={() => { setPayTouched(true); setPays([...pays, { method: 'card', amount: Math.max(0, total - paid) }]); }}>＋支払を追加</button><button className="btn text-xs" onClick={() => { setPayTouched(false); setPays([{ method: 'cash', amount: total }]); }}>現金ちょうど</button></div>
        <div className="text-sm mb-2">お預かり {yen(paid)}　<span className={change < 0 ? 'text-rose-600' : ''}>お釣り {yen(Math.max(0, change))}</span></div>
        {err && <div className="text-rose-600 text-sm mb-2">{err}</div>}
        <button className="btn-primary w-full" disabled={!lines.length || busy || booking?.status === 'done'} aria-busy={busy} onClick={confirm}>{busy ? "保存しています…" : "会計を確定する"}</button>
      </div>
    </div>
  );
}
