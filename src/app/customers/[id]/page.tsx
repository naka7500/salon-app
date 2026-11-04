"use client";
import { use, useEffect, useRef, useState } from "react";
import { getRepo, yen, hm, todayStr, CHANNEL_LABEL, STATUS_LABEL, type Customer, type Booking, type Sale, type KarteEntry, type Staff } from "@/lib/db";

const EYELASH_FIELDS = ["デザイン", "本数", "毛質", "太さ", "長さ", "カール", "グルー", "持ち"];

export default function CustomerPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const repo = getRepo();
  const [c, setC] = useState<Customer|null>(null); const [bookings, setBookings] = useState<Booking[]>([]); const [sales, setSales] = useState<Sale[]>([]);
  const [kartes, setKartes] = useState<KarteEntry[]>([]); const [staff, setStaff] = useState<Staff[]>([]);
  const [open, setOpen] = useState(false);
  const [k, setK] = useState<{ record: Record<string,string>; memo: string; next_proposal: string; staff_id: string; visited_on: string }>({ record: {}, memo: "", next_proposal: "", staff_id: "", visited_on: todayStr() });
  const canvasRef = useRef<HTMLCanvasElement>(null); const drawing = useRef(false);

  async function load() { setC((await repo.customer(id)) || null); setBookings(await repo.bookingsOfCustomer(id)); setSales(await repo.salesOfCustomer(id)); setKartes(await repo.kartes(id)); }
  useEffect(() => { load(); repo.staff().then(s => { setStaff(s); setK(x => ({ ...x, staff_id: s[0]?.id || "" })); }); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  function pos(e: React.PointerEvent<HTMLCanvasElement>) { const r = e.currentTarget.getBoundingClientRect(); return [(e.clientX - r.left) * (e.currentTarget.width / r.width), (e.clientY - r.top) * (e.currentTarget.height / r.height)]; }
  function down(e: React.PointerEvent<HTMLCanvasElement>) { drawing.current = true; const ctx = e.currentTarget.getContext("2d")!; const [x, y] = pos(e); ctx.beginPath(); ctx.moveTo(x, y); ctx.lineWidth = 2.5; ctx.lineCap = "round"; ctx.strokeStyle = "#1e4d38"; }
  function move(e: React.PointerEvent<HTMLCanvasElement>) { if (!drawing.current) return; const ctx = e.currentTarget.getContext("2d")!; const [x, y] = pos(e); ctx.lineTo(x, y); ctx.stroke(); }
  function up() { drawing.current = false; }
  function clear() { const cv = canvasRef.current!; cv.getContext("2d")!.clearRect(0, 0, cv.width, cv.height); }

  async function saveKarte() {
    const cv = canvasRef.current; let hw: string[] = [];
    if (cv) { const blank = document.createElement("canvas"); blank.width = cv.width; blank.height = cv.height; if (cv.toDataURL() !== blank.toDataURL()) hw = [cv.toDataURL("image/png")]; }
    await repo.addKarte({ customer_id: id, store_id: "", staff_id: k.staff_id || null, visited_on: k.visited_on, template: "eyelash", record: k.record, memo: k.memo, next_proposal: k.next_proposal, handwriting: hw });
    setOpen(false); setK({ record: {}, memo: "", next_proposal: "", staff_id: k.staff_id, visited_on: todayStr() }); await load();
  }

  if (!c) return <div>読み込み中…</div>;
  const visits = bookings.filter(b => b.status === 'done').length;
  const last = bookings.find(b => b.status === 'done');
  return (
    <div className="max-w-4xl">
      <div className="card mb-3 flex flex-wrap items-start gap-4">
        <div><div className="text-xl font-bold">{c.name}</div><div className="text-sm text-stone-500">{c.kana}　{c.phone}　{c.source && `経路:${c.source}`}</div></div>
        <div className="ml-auto text-sm text-right"><div>来店 {visits}回　累計 {yen(sales.filter(s => s.status !== 'voided').reduce((a, s) => a + s.total, 0))}</div><div className="text-stone-500">最終来店 {last ? last.start_at.slice(0, 10) : '—'}</div></div>
      </div>
      <div className="grid md:grid-cols-2 gap-3">
        <div className="card">
          <div className="flex items-center justify-between mb-2"><div className="font-bold">カルテ</div><button className="btn-primary text-xs" onClick={() => setOpen(!open)}>＋今日の記録</button></div>
          {open && <div className="border rounded p-2 mb-2 bg-stone-50">
            <div className="grid grid-cols-2 gap-1 mb-2">
              <input type="date" className="inp" value={k.visited_on} onChange={e => setK({ ...k, visited_on: e.target.value })} />
              <select className="inp" value={k.staff_id} onChange={e => setK({ ...k, staff_id: e.target.value })}>{staff.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
              {EYELASH_FIELDS.map(f => <input key={f} className="inp" placeholder={f} value={k.record[f] || ''} onChange={e => setK({ ...k, record: { ...k.record, [f]: e.target.value } })} />)}
            </div>
            <textarea className="inp w-full mb-1" rows={2} placeholder="接客メモ（会話・好み）" value={k.memo} onChange={e => setK({ ...k, memo: e.target.value })} />
            <textarea className="inp w-full mb-1" rows={2} placeholder="次回提案（施術中に話したこと・次にやること）" value={k.next_proposal} onChange={e => setK({ ...k, next_proposal: e.target.value })} />
            <div className="lbl">手書き（指・ペンで書けます）</div>
            <canvas ref={canvasRef} width={600} height={300} className="w-full bg-white border rounded touch-none" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerLeave={up} />
            <div className="flex gap-2 justify-end mt-2"><button className="btn text-xs" onClick={clear}>手書きを消す</button><button className="btn-primary" onClick={saveKarte}>保存</button></div>
          </div>}
          {kartes.length === 0 && <div className="text-sm text-stone-400">まだ記録がありません</div>}
          {kartes.map(e => <div key={e.id} className="border-t py-2 text-sm">
            <div className="font-semibold">{e.visited_on} <span className="text-xs text-stone-500">{staff.find(s => s.id === e.staff_id)?.name}</span></div>
            <div className="text-xs text-stone-600">{Object.entries(e.record).filter(([, v]) => v).map(([f, v]) => `${f}:${v}`).join("　")}</div>
            {e.memo && <div className="text-xs mt-1">メモ：{e.memo}</div>}
            {e.next_proposal && <div className="text-xs mt-1 text-[#2f6b4f]">次回提案：{e.next_proposal}</div>}
            {e.handwriting.map((h, i) => <img key={i} src={h} alt="手書き" className="w-full border rounded mt-1 bg-white" />)}
          </div>)}
        </div>
        <div>
          <div className="card mb-3"><div className="font-bold mb-1">来店履歴</div>
            {bookings.map(b => <div key={b.id} className="text-sm border-t py-1 flex gap-2"><span>{b.start_at.slice(0, 10)} {hm(b.start_at)}</span><span className="text-xs text-stone-500">{CHANNEL_LABEL[b.channel]}</span><span className="ml-auto text-xs">{STATUS_LABEL[b.status]}</span></div>)}
          </div>
          <div className="card"><div className="font-bold mb-1">お会計履歴</div>
            {sales.map(s => <div key={s.id} className={`text-sm border-t py-1 ${s.status === 'voided' ? 'line-through text-stone-400' : ''}`}><div className="flex"><span>{s.sold_at.slice(0, 10)} {s.sale_no}</span><span className="ml-auto">{yen(s.total)}</span></div><div className="text-xs text-stone-500">{s.lines.map(l => l.name).join("・")}</div></div>)}
          </div>
        </div>
      </div>
    </div>
  );
}
