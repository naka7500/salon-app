"use client";
import { use, useEffect, useRef, useState } from "react";
import { getRepo, yen, hm, todayStr, CHANNEL_LABEL, STATUS_LABEL, staffLabel, type Customer, type Booking, type Sale, type KarteEntry, type Staff, type IntakeAnswer } from "@/lib/db";

// カルテのテンプレート（業態別）。既存のまつげカルテはそのまま
const TEMPLATES: Record<string, { label: string; fields: string[] }> = {
  eyelash: { label: "まつげ", fields: ["デザイン", "本数", "毛質", "太さ", "長さ", "カール", "グルー", "持ち"] },
  headspa: { label: "ヘッドスパ", fields: ["頭皮の状態", "抜け毛", "かゆみ", "睡眠", "お悩み", "使った薬剤"] },
};
const HEADSPA_CHOICES: Record<string, string[]> = { "頭皮の状態": ["健康", "乾燥", "脂性", "赤み", "硬い"], "抜け毛": ["少ない", "普通", "多い"], "かゆみ": ["なし", "少し", "あり"], "睡眠": ["良い", "普通", "悪い"] };
const photoOf = (photos: string[] | null | undefined, kind: "before" | "after") => (photos || []).filter(p => p.startsWith(kind + "|")).map(p => p.slice(kind.length + 1));
function IntakeList({ items, title = "事前問診（ネット予約）" }: { items: IntakeAnswer[]; title?: string }) {
  return <div className="rounded bg-emerald-50 border border-emerald-200 px-2 py-1 mt-1"><div className="text-[11px] font-semibold text-emerald-900">{title}</div><ul className="text-xs">{items.map(a => <li key={a.label}><span className="text-stone-500">{a.label}：</span>{a.answer}</li>)}</ul></div>;
}

export default function CustomerPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const repo = getRepo();
  const [c, setC] = useState<Customer|null>(null); const [bookings, setBookings] = useState<Booking[]>([]); const [sales, setSales] = useState<Sale[]>([]);
  const [kartes, setKartes] = useState<KarteEntry[]>([]); const [staff, setStaff] = useState<Staff[]>([]); const [allStaff, setAllStaff] = useState<Staff[]>([]);
  const [open, setOpen] = useState(false);
  const [k, setK] = useState<{ record: Record<string,string>; memo: string; next_proposal: string; staff_id: string; visited_on: string; template: string; before: string; after: string; booking_id: string | null; intake: IntakeAnswer[]; booking_no: string | null }>({ record: {}, memo: "", next_proposal: "", staff_id: "", visited_on: todayStr(), template: "eyelash", before: "", after: "", booking_id: null, intake: [], booking_no: null });
  const [defTemplate, setDefTemplate] = useState("eyelash");
  const canvasRef = useRef<HTMLCanvasElement>(null); const drawing = useRef(false);

  async function load() { setC((await repo.customer(id)) || null); setBookings(await repo.bookingsOfCustomer(id)); setSales(await repo.salesOfCustomer(id)); setKartes(await repo.kartes(id)); }
  useEffect(() => { load(); repo.allStaff().then(setAllStaff).catch(() => {}); repo.staff().then(s => { setStaff(s); setK(x => ({ ...x, staff_id: x.staff_id || s[0]?.id || "" })); }); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  // 業態でテンプレートを決める。会計後の「カルテを書く」（?karte=1&booking=…）なら、その予約の問診を貼って開く
  useEffect(() => { (async () => {
    const st = await repo.store(); const t = st.business_type === "headspa" ? "headspa" : "eyelash"; setDefTemplate(t); setK(x => ({ ...x, template: t }));
    const q = new URLSearchParams(window.location.search);
    if (q.get("karte") === "1") {
      const bid = q.get("booking"); const b = bid ? await repo.booking(bid) : undefined;
      setK(x => ({ ...x, template: t, booking_id: b?.id || null, intake: b?.intake || [], booking_no: b?.booking_no || null, staff_id: b?.staff_id || x.staff_id, visited_on: b ? new Date(b.start_at).toLocaleDateString("sv-SE") : x.visited_on }));
      setOpen(true);
    }
  })(); }, [repo]);

  function pos(e: React.PointerEvent<HTMLCanvasElement>) { const r = e.currentTarget.getBoundingClientRect(); return [(e.clientX - r.left) * (e.currentTarget.width / r.width), (e.clientY - r.top) * (e.currentTarget.height / r.height)]; }
  function down(e: React.PointerEvent<HTMLCanvasElement>) { drawing.current = true; const ctx = e.currentTarget.getContext("2d")!; const [x, y] = pos(e); ctx.beginPath(); ctx.moveTo(x, y); ctx.lineWidth = 2.5; ctx.lineCap = "round"; ctx.strokeStyle = "#1e4d38"; }
  function move(e: React.PointerEvent<HTMLCanvasElement>) { if (!drawing.current) return; const ctx = e.currentTarget.getContext("2d")!; const [x, y] = pos(e); ctx.lineTo(x, y); ctx.stroke(); }
  function up() { drawing.current = false; }
  function clear() { const cv = canvasRef.current!; cv.getContext("2d")!.clearRect(0, 0, cv.width, cv.height); }

  async function saveKarte() {
    const cv = canvasRef.current; let hw: string[] = [];
    if (cv) { const blank = document.createElement("canvas"); blank.width = cv.width; blank.height = cv.height; if (cv.toDataURL() !== blank.toDataURL()) hw = [cv.toDataURL("image/png")]; }
    const photos = [...k.before.split(/\s+/).filter(Boolean).map(u => `before|${u}`), ...k.after.split(/\s+/).filter(Boolean).map(u => `after|${u}`)];
    await repo.addKarte({ customer_id: id, store_id: "", booking_id: k.booking_id, staff_id: k.staff_id || null, visited_on: k.visited_on, template: k.template, record: k.record, memo: k.memo, next_proposal: k.next_proposal, handwriting: hw, photos, health: k.intake.length ? { intake: k.intake, booking_no: k.booking_no } : null });
    setOpen(false); setK({ record: {}, memo: "", next_proposal: "", staff_id: k.staff_id, visited_on: todayStr(), template: defTemplate, before: "", after: "", booking_id: null, intake: [], booking_no: null }); await load();
  }

  if (!c) return <div>読み込み中…</div>;
  const visits = bookings.filter(b => b.status === 'done').length;
  const last = bookings.find(b => b.status === 'done');
  // ネット予約の事前問診（これからの予約・まだカルテに貼っていないもの）
  const pastedBookings = new Set(kartes.map(e => e.booking_id).filter(Boolean));
  const intakeBookings = bookings.filter(b => b.intake && b.intake.length > 0 && !pastedBookings.has(b.id));
  const fields = TEMPLATES[k.template]?.fields || TEMPLATES.eyelash.fields;
  return (
    <div className="max-w-4xl">
      <div className="card mb-3 flex flex-wrap items-start gap-4">
        <div><div className="text-xl font-bold">{c.name}</div><div className="text-sm text-stone-500">{c.kana}　{c.phone}　{c.source && `経路:${c.source}`}</div></div>
        <div className="ml-auto text-sm text-right"><div>来店 {visits}回　累計 {yen(sales.filter(s => s.status !== 'voided').reduce((a, s) => a + s.total, 0))}</div><div className="text-stone-500">最終来店 {last ? last.start_at.slice(0, 10) : '—'}</div></div>
      </div>
      <div className="grid md:grid-cols-2 gap-3">
        <div className="card">
          <div className="flex items-center justify-between mb-2"><div className="font-bold">カルテ</div><button className="btn-primary text-xs" onClick={() => setOpen(!open)}>＋今日の記録</button></div>
          {intakeBookings.length > 0 && !open && intakeBookings.slice(0, 3).map(b => (
            <div key={b.id} className="mb-2 text-sm">
              <div className="flex items-center gap-2"><span className="text-xs text-stone-600">{b.start_at.slice(0, 10)} {hm(b.start_at)} の予約{b.booking_no ? `（${b.booking_no}）` : ""}</span>
                <button className="btn text-xs ml-auto" onClick={() => { setK({ ...k, booking_id: b.id, intake: b.intake || [], booking_no: b.booking_no || null, staff_id: b.staff_id || k.staff_id, visited_on: new Date(b.start_at).toLocaleDateString("sv-SE") }); setOpen(true); }}>この問診を貼ってカルテを書く</button></div>
              <IntakeList items={b.intake || []} />
            </div>
          ))}
          {open && <div className="border rounded p-2 mb-2 bg-stone-50">
            <div className="flex items-center gap-1 mb-2 text-xs"><span className="text-stone-500">テンプレート</span>
              {Object.entries(TEMPLATES).map(([key, t]) => <button key={key} className={`px-2 py-1 rounded border ${k.template === key ? "bg-canopy text-white border-canopy" : "bg-white"}`} onClick={() => setK({ ...k, template: key, record: {} })}>{t.label}</button>)}
            </div>
            {k.intake.length > 0 && <div className="mb-2"><IntakeList items={k.intake} title={`事前問診（${k.booking_no || "ネット予約"}）— このカルテに貼られます`} /></div>}
            <div className="grid grid-cols-2 gap-1 mb-2">
              <input type="date" className="inp" value={k.visited_on} onChange={e => setK({ ...k, visited_on: e.target.value })} />
              <select className="inp" value={k.staff_id} onChange={e => setK({ ...k, staff_id: e.target.value })}>{staff.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}{k.staff_id && !staff.some(s => s.id === k.staff_id) && <option value={k.staff_id}>{staffLabel(allStaff.find(s => s.id === k.staff_id))}</option>}</select>
              {fields.map(f => <div key={f}>
                <input className="inp w-full" placeholder={f} aria-label={f} list={HEADSPA_CHOICES[f] && k.template === "headspa" ? `dl-${f}` : undefined} value={k.record[f] || ''} onChange={e => setK({ ...k, record: { ...k.record, [f]: e.target.value } })} />
                {HEADSPA_CHOICES[f] && k.template === "headspa" && <datalist id={`dl-${f}`}>{HEADSPA_CHOICES[f].map(o => <option key={o} value={o} />)}</datalist>}
              </div>)}
            </div>
            <div className="grid grid-cols-2 gap-1 mb-2">
              <label className="text-xs text-stone-500">写真URL（施術前）<input className="inp w-full" placeholder="https://..." value={k.before} onChange={e => setK({ ...k, before: e.target.value })} /></label>
              <label className="text-xs text-stone-500">写真URL（施術後）<input className="inp w-full" placeholder="https://..." value={k.after} onChange={e => setK({ ...k, after: e.target.value })} /></label>
            </div>
            <textarea className="inp w-full mb-1" rows={2} placeholder="接客メモ（会話・好み）" value={k.memo} onChange={e => setK({ ...k, memo: e.target.value })} />
            <textarea className="inp w-full mb-1" rows={2} placeholder="次回提案（施術中に話したこと・次にやること）" value={k.next_proposal} onChange={e => setK({ ...k, next_proposal: e.target.value })} />
            <div className="lbl">手書き（指・ペンで書けます）</div>
            <canvas ref={canvasRef} width={600} height={300} className="w-full bg-white border rounded touch-none" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerLeave={up} />
            <div className="flex gap-2 justify-end mt-2"><button className="btn text-xs" onClick={clear}>手書きを消す</button><button className="btn-primary" onClick={saveKarte}>保存</button></div>
          </div>}
          {kartes.length === 0 && <div className="text-sm text-stone-400">まだ記録がありません</div>}
          {kartes.map(e => <div key={e.id} className="border-t py-2 text-sm">
            <div className="font-semibold">{e.visited_on} <span className="text-xs text-stone-500">{(allStaff.find(s => s.id === e.staff_id) || staff.find(s => s.id === e.staff_id))?.name}</span> <span className="text-[10px] px-1 rounded bg-stone-100 text-stone-600">{TEMPLATES[e.template]?.label || e.template}</span></div>
            <div className="text-xs text-stone-600">{Object.entries(e.record).filter(([, v]) => v).map(([f, v]) => `${f}:${v}`).join("　")}</div>
            {e.memo && <div className="text-xs mt-1">メモ：{e.memo}</div>}
            {e.next_proposal && <div className="text-xs mt-1 text-canopy">次回提案：{e.next_proposal}</div>}
            {e.health?.intake && e.health.intake.length > 0 && <IntakeList items={e.health.intake} title={`事前問診${e.health.booking_no ? `（${e.health.booking_no}）` : ""}`} />}
            {(photoOf(e.photos, "before").length > 0 || photoOf(e.photos, "after").length > 0) && <div className="grid grid-cols-2 gap-1 mt-1">
              {(["before", "after"] as const).map(kind => <div key={kind}><div className="text-[10px] text-stone-500">{kind === "before" ? "施術前" : "施術後"}</div>{photoOf(e.photos, kind).map(u => <a key={u} href={u} target="_blank" rel="noreferrer"><img src={u} alt={kind === "before" ? "施術前" : "施術後"} className="w-full aspect-square object-cover rounded border bg-stone-100" /></a>)}</div>)}
            </div>}
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
