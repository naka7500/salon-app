"use client";
/* eslint-disable @next/next/no-img-element -- 写真・手書きは外部URL／data: URL／期限つきURL */
import { CustomerLineCard, useLineLink } from "@/components/LineLinkQr";
import { CustomerLineContact, useLineInfo } from "@/app/bookings/LineContact";
import { DuplicatePhoneHint } from "@/components/DuplicatePhone";
import { useRouter } from "next/navigation";
import { bookingMenuLabel } from "@/lib/web";
import { use, useCallback, useEffect, useState } from "react";
import { getRepo, yen, hm, todayStr, CHANNEL_LABEL, STATUS_LABEL, staffLabel, type Customer, type Booking, type Sale, type KarteEntry, type Staff, type IntakeAnswer, type KartePage, type KarteBackground, type KartePageDraft, type HistVisit, type Menu, type Store, IMPORT_SOURCE_LABEL } from "@/lib/db";
import { histRange } from "@/lib/importer/plan";
import HandwritingEditor, { blankPage, type EditorPage } from "@/components/karte/HandwritingEditor";
import { PageThumbs, PageLightbox, PrintSheet, type ShownPage } from "@/components/karte/KarteViews";
import { visibleBuiltins, pageToEditor } from "@/components/karte/karteBg";
import { blobToDataUrl } from "@/components/karte/ink";
import { ConsentCard } from "./ConsentCard";

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
type Draft = KartePageDraft & { url: string };
type Form = { record: Record<string, string>; memo: string; next_proposal: string; staff_id: string; visited_on: string; template: string; before: string; after: string; booking_id: string | null; intake: IntakeAnswer[]; booking_no: string | null };
const emptyForm = (staff_id: string, template: string): Form => ({ record: {}, memo: "", next_proposal: "", staff_id, visited_on: todayStr(), template, before: "", after: "", booking_id: null, intake: [], booking_no: null });

export default function CustomerPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const repo = getRepo();
  const router = useRouter();
  const [c, setC] = useState<Customer | null>(null); const [bookings, setBookings] = useState<Booking[]>([]); const [sales, setSales] = useState<Sale[]>([]);
  const [kartes, setKartes] = useState<KarteEntry[]>([]); const [staff, setStaff] = useState<Staff[]>([]); const [allStaff, setAllStaff] = useState<Staff[]>([]);
  const [open, setOpen] = useState(false);
  const [k, setK] = useState<Form>(emptyForm("", "eyelash"));
  const [defTemplate, setDefTemplate] = useState("eyelash");
  const [businessType, setBusinessType] = useState<string>("eyelash");
  // 手書き（0010）
  const [ready10, setReady10] = useState<boolean | null>(null);
  const [ready24, setReady24] = useState(false);
  const [me, setMe] = useState<Staff | null>(null);
  const [pages, setPages] = useState<Record<string, KartePage[]>>({});
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [bgs, setBgs] = useState<KarteBackground[]>([]);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [editor, setEditor] = useState<null | { entry: KarteEntry | null; initial: EditorPage[] }>(null);
  const [viewer, setViewer] = useState<null | { entry: KarteEntry; index: number }>(null);
  const [printing, setPrinting] = useState<KarteEntry | null>(null);
  const [msg, setMsg] = useState("");
  // 旧POS（サロンアンサー・カミングスーン）から取り込んだ来店（0012）。売上には入れない
  const [hist, setHist] = useState<HistVisit[]>([]);
  // 上のまとめ（LINE・次のご予約・メニュー名）
  const [store, setStore] = useState<Store | null>(null);
  const [menus, setMenus] = useState<Menu[]>([]);
  const [allVisits, setAllVisits] = useState(false);
  const [now] = useState(() => Date.now());
  const line = useLineLink(id);
  const lineInfo = useLineInfo();

  const load = useCallback(async () => {
    const [cc, bs, ss, ks, caps] = await Promise.all([repo.customer(id), repo.bookingsOfCustomer(id), repo.salesOfCustomer(id), repo.kartes(id), repo.capabilities()]);
    setC(cc || null); setBookings(bs); setSales(ss); setKartes(ks);
    setHist(caps.import12 ? (await repo.historicalVisits(id).catch(() => null)) || [] : []);
    const ok = !!caps.karte10; setReady10(ok); setReady24(!!caps.karte24);
    if (ok && ks.length) {
      const ps = (await repo.kartePages(ks.map(e => e.id)).catch(() => null)) || [];
      const by: Record<string, KartePage[]> = {}; for (const p of ps) (by[p.karte_entry_id] ||= []).push(p);
      Object.values(by).forEach(a => a.sort((x, y) => x.page_no - y.page_no));
      setPages(by);
      const paths = ps.map(p => p.png_path).filter((x): x is string => !!x);
      if (paths.length) setUrls(await repo.karteFileUrls(paths).catch(() => ({})));
    } else setPages({});
  }, [repo, id]);
  useEffect(() => {
    void Promise.resolve().then(load);
    repo.allStaff().then(setAllStaff).catch(() => {});
    repo.me().then(setMe).catch(() => {});
    repo.staff().then(s => { setStaff(s); setK(x => ({ ...x, staff_id: x.staff_id || s[0]?.id || "" })); });
    repo.karteBackgrounds().then(b => setBgs(b || [])).catch(() => {});
    repo.allMenus().then(setMenus).catch(() => {});
  }, [repo, load]);
  // 業態でテンプレートを決める。会計後の「カルテを書く」（?karte=1&booking=…）なら、その予約の問診を貼って開く
  useEffect(() => { (async () => {
    const st = await repo.store(); setStore(st); const t = st.business_type === "headspa" ? "headspa" : "eyelash"; setDefTemplate(t); setBusinessType(st.business_type); setK(x => ({ ...x, template: t }));
    const q = new URLSearchParams(window.location.search);
    if (q.get("karte") === "1") {
      const bid = q.get("booking"); const b = bid ? await repo.booking(bid) : undefined;
      setK(x => ({ ...x, template: t, booking_id: b?.id || null, intake: b?.intake || [], booking_no: b?.booking_no || null, staff_id: b?.staff_id || x.staff_id, visited_on: b ? new Date(b.start_at).toLocaleDateString("sv-SE") : x.visited_on }));
      setOpen(true);
    }
  })(); }, [repo]);

  const builtins = visibleBuiltins(bgs, businessType);
  const firstBg = builtins[0] ? { kind: "builtin" as const, key: builtins[0].key } : { kind: "none" as const };
  function openNewEditor() { setEditor({ entry: null, initial: drafts.length ? drafts.map(d => ({ id: d.id, ink: d.strokes, bg: d.bg, opacity: d.opacity, images: d.images ?? [] })) : [blankPage(firstBg)] }); }
  function openEntryEditor(e: KarteEntry) { const ps = pages[e.id] || []; setViewer(null); setEditor({ entry: e, initial: ps.length ? ps.map(pageToEditor) : [blankPage(firstBg)] }); }
  function setDraftList(list: KartePageDraft[]) { drafts.forEach(d => URL.revokeObjectURL(d.url)); setDrafts(list.map(d => ({ ...d, url: URL.createObjectURL(d.image) }))); }

  async function onEditorSave(list: KartePageDraft[]) {
    if (!editor) return;
    if (!editor.entry) { setDraftList(list); setEditor(null); return; }   // 新しいカルテ：カルテの「保存」でまとめて保存
    await repo.saveKartePages(editor.entry.id, list);
    setEditor(null); setMsg("手書きを保存しました"); await load();
  }

  async function saveKarte() {
    try {
      setMsg("");
      const photos = [...k.before.split(/\s+/).filter(Boolean).map(u => `before|${u}`), ...k.after.split(/\s+/).filter(Boolean).map(u => `after|${u}`)];
      const hasInk = drafts.some(d => d.strokes.items.length || d.bg.kind !== "none");
      const list = hasInk ? drafts : [];
      // 0010 の前：手書きは「画像1枚ずつ」で今までどおり保存（あとから書き直しはできない）
      const hw = ready10 ? [] : await Promise.all(list.map(d => blobToDataUrl(d.image)));
      const e = await repo.addKarte({ customer_id: id, store_id: "", booking_id: k.booking_id, staff_id: k.staff_id || null, visited_on: k.visited_on, template: k.template, record: k.record, memo: k.memo, next_proposal: k.next_proposal, handwriting: hw, photos, health: k.intake.length ? { intake: k.intake, booking_no: k.booking_no } : null });
      if (ready10 && list.length) {
        try { await repo.saveKartePages(e.id, list); }
        catch (er) { setMsg(`カルテは保存しましたが、手書きを保存できませんでした：${(er as Error).message}（カルテの「手書き」から書き直せます）`); }
      }
      setOpen(false); setDraftList([]); setK(emptyForm(k.staff_id, defTemplate)); await load();
    } catch (er) { setMsg((er as Error).message); }
  }

  const shownOf = useCallback((e: KarteEntry): ShownPage[] => [
    ...(pages[e.id] || []).map((p, i) => ({ key: p.id, url: p.png_path ? urls[p.png_path] : undefined, label: `${i + 1}` })),
    ...e.handwriting.map((h, i) => ({ key: `old-${i}`, url: h, label: "以前の手書き" })),
  ], [pages, urls]);
  const endPrint = useCallback(() => setPrinting(null), []);

  if (!c) return <div>読み込み中…</div>;
  const visits = bookings.filter(b => b.status === 'done').length;
  const last = bookings.find(b => b.status === 'done');
  const histR = histRange(hist);
  const histCount = Math.max(hist.filter(h => h.kind === 'visit').length, ...hist.filter(h => h.kind === 'summary').map(h => h.visit_count || 0));
  const lastAll = [last?.start_at.slice(0, 10), histR.last].filter(Boolean).sort().pop() || '';
  // ネット予約の事前問診（これからの予約・まだカルテに貼っていないもの）
  const pastedBookings = new Set(kartes.map(e => e.booking_id).filter(Boolean));
  const intakeBookings = bookings.filter(b => b.intake && b.intake.length > 0 && !pastedBookings.has(b.id));
  // 次のご予約（これからの・キャンセルでないもの）と、いちばん新しいメモ
  const nextBooking = [...bookings].filter(b => (b.status === 'booked' || b.status === 'arrived') && Date.parse(b.end_at) >= now).sort((a, b) => a.start_at.localeCompare(b.start_at))[0] || null;
  const menuOf = (b: Booking) => bookingMenuLabel(b.menu_ids || [], menus, false);
  const latestMemo = kartes.find(e => (e.memo || '').trim() || (e.next_proposal || '').trim()) || null;
  const excerpt = (t: string, n = 80) => (t.length > n ? `${t.slice(0, n)}…` : t);
  const telOf = (p?: string | null) => (p || '').replace(/[^\d+]/g, '');
  const SHOW_VISITS = 8;
  const shownBookings = allVisits ? bookings : bookings.slice(0, SHOW_VISITS);
  const jump = (sid: string) => document.getElementById(sid)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  const fields = TEMPLATES[k.template]?.fields || TEMPLATES.eyelash.fields;
  const staffName = (sid?: string | null) => (allStaff.find(s => s.id === sid) || staff.find(s => s.id === sid))?.name;
  return (
    <div className="max-w-4xl">
      <div className="card mb-3" data-testid="customer-summary">
        <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
          <div className="min-w-0">
            <div className="text-xl font-bold">{c.name}<span className="text-sm font-normal text-ink-mute">　様</span></div>
            {c.kana && <div className="text-xs text-stone-500">{c.kana}</div>}
            <div className="text-sm mt-1 flex flex-wrap gap-x-4 gap-y-1">
              {c.phone ? <a className="text-canopy-deep underline" href={`tel:${telOf(c.phone)}`} data-testid="customer-tel">☎ {c.phone}</a> : <span className="text-ink-mute">電話番号なし</span>}
              {c.email && <a className="text-canopy-deep underline break-all" href={`mailto:${c.email}`}>{c.email}</a>}
              {c.source && <span className="text-xs text-stone-500 self-center">経路:{c.source}</span>}
            </div>
          </div>
          <div className="ml-auto text-sm text-right">
            <div>来店 <b className="tabular-nums">{visits}</b>回　累計 {yen(sales.filter(s => s.status !== 'voided').reduce((a, s) => a + s.total, 0))}</div>
            <div className="text-stone-500">最終来店 {lastAll || '—'}{lastAll && histR.last === lastAll && (!last || last.start_at.slice(0, 10) < lastAll) ? "（前のPOS）" : ""}</div>
            {hist.length > 0 && <div className="text-xs text-ink-mute">前のPOS：来店 {histCount}回{histR.first ? `・初回 ${histR.first}` : ""}</div>}
          </div>
        </div>
        <div className="mt-3 pt-2 border-t border-line">
          <CustomerLineContact customer={c} link={line.ready ? line.link : undefined} info={lineInfo.info} store={store} nextBooking={nextBooking} nextMenu={nextBooking ? menuOf(nextBooking) : ''} onSent={lineInfo.onSent} onLinkChanged={line.reload} />
        </div>
        <div className="mt-2 grid sm:grid-cols-2 gap-2 text-sm">
          <div className="rounded border border-line px-2 py-1.5" data-testid="customer-next">
            <div className="text-[11px] text-ink-mute">次のご予約</div>
            {nextBooking ? <div><b>{nextBooking.start_at.slice(0, 10)} {hm(nextBooking.start_at)}〜</b> <span className="text-xs text-ink-soft">{menuOf(nextBooking)}{staffName(nextBooking.staff_id) ? `／${staffName(nextBooking.staff_id)}` : ""}</span></div> : <div className="text-ink-mute">なし</div>}
          </div>
          <div className="rounded border border-line px-2 py-1.5" data-testid="customer-latest-memo">
            <div className="text-[11px] text-ink-mute">いちばん新しいメモ{latestMemo ? `（${latestMemo.visited_on}）` : ""}</div>
            {latestMemo ? <div className="text-xs whitespace-pre-wrap">{latestMemo.memo?.trim() ? excerpt(latestMemo.memo.trim()) : ""}{latestMemo.next_proposal?.trim() ? <span className="block text-canopy">次回提案：{excerpt(latestMemo.next_proposal.trim(), 60)}</span> : null}</div> : <div className="text-ink-mute">まだありません</div>}
          </div>
        </div>
        <nav className="mt-2 flex flex-wrap gap-2" aria-label="このページの中を移動">
          <button type="button" className="btn !min-h-9 text-xs max-sm:!min-h-11" onClick={() => jump('sec-karte')} data-testid="jump-karte">カルテ・メモ（{kartes.length}）</button>
          <button type="button" className="btn !min-h-9 text-xs max-sm:!min-h-11" onClick={() => jump('sec-visits')} data-testid="jump-visits">来店履歴（{bookings.length}）</button>
          <button type="button" className="btn !min-h-9 text-xs max-sm:!min-h-11" onClick={() => jump('sec-sales')}>お会計履歴（{sales.length}）</button>
        </nav>
      </div>
      {c.merged_into && <div className="card mb-3 text-sm bg-amber-50 border-amber-300 text-amber-900" data-testid="customer-merged">このお客様は別の登録に統合済みです。<a className="underline ml-1" href={`/customers/${c.merged_into}`}>残した登録を開く</a></div>}
      {!c.merged_into && <DuplicatePhoneHint customer={c} onMerged={(kept) => { if (kept !== c.id) router.replace(`/customers/${kept}`); else void load(); }} />}
      <CustomerLineCard customerId={c.id} customerName={c.name} />
      <ConsentCard customerId={c.id} me={me} staffName={staffName} />
      {(c.birthday || c.postal_code || c.address || c.email || c.external_id) && <div className="card mb-3 text-sm flex flex-wrap gap-x-5 gap-y-1">
        {c.email && <span><span className="text-ink-mute text-xs mr-1">メール</span>{c.email}</span>}
        {c.birthday && <span><span className="text-ink-mute text-xs mr-1">生年月日</span>{c.birthday}</span>}
        {(c.postal_code || c.address) && <span><span className="text-ink-mute text-xs mr-1">住所</span>{c.postal_code ? `〒${c.postal_code} ` : ""}{c.address}</span>}
        {c.external_id && <span><span className="text-ink-mute text-xs mr-1">前のPOSの顧客番号</span>{c.external_id}{c.import_source ? `（${IMPORT_SOURCE_LABEL[c.import_source]}）` : ""}</span>}
      </div>}
      {msg && <div className={`mb-3 text-sm px-3 py-2 rounded border ${msg.includes("しました") && !msg.includes("できません") ? "bg-moss border-line text-canopy-deep" : "bg-amber-50 border-amber-300 text-amber-900"}`} role="status">{msg}</div>}
      <div className="grid md:grid-cols-2 gap-3">
        <div className="card scroll-mt-20 max-md:order-2" id="sec-karte">
          <div className="flex items-center justify-between mb-2"><div className="font-bold">カルテ・メモ</div><button className="btn-primary text-xs" onClick={() => setOpen(!open)}>＋今日の記録</button></div>
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
            <div className="lbl mt-1">手書き（全画面で書けます。背景に目元・頭皮の図や写真を置けます）</div>
            {drafts.length > 0 && <PageThumbs size="sm" pages={drafts.map((d, i) => ({ key: d.id, url: d.url, label: `${i + 1}` }))} onOpen={() => openNewEditor()} />}
            <div className="flex flex-wrap gap-2 items-center mt-1">
              <button className="btn" onClick={openNewEditor}>{drafts.length ? `✎ 手書きを続ける（${drafts.length}ページ）` : "✎ 手書きを書く"}</button>
              {drafts.length > 0 && <button className="btn-quiet text-danger" onClick={() => { if (confirm("書いた手書きを消しますか？")) setDraftList([]); }}>手書きを消す</button>}
              {ready10 === false && <span className="text-[11px] text-amber-800">※DB更新（0010）の前なので、手書きは画像として保存され、あとから書き直しはできません</span>}
            </div>
            <div className="flex gap-2 justify-end mt-2"><button className="btn text-xs" onClick={() => setOpen(false)}>閉じる</button><button className="btn-primary" onClick={saveKarte}>保存</button></div>
          </div>}
          {kartes.length === 0 && <div className="text-sm text-stone-400">まだ記録がありません</div>}
          {kartes.map(e => { const shown = shownOf(e); const hasPages = (pages[e.id] || []).length > 0; return <div key={e.id} className="border-t py-2 text-sm" data-testid="karte-entry">
            <div className="flex items-center gap-1 flex-wrap">
              <span className="font-semibold">{e.visited_on}</span> <span className="text-xs text-stone-500">{staffName(e.staff_id)}</span> <span className="text-[10px] px-1 rounded bg-stone-100 text-stone-600">{TEMPLATES[e.template]?.label || e.template}</span>
              <span className="ml-auto flex gap-1">
                {ready10 && <button className="btn text-xs min-h-9" onClick={() => openEntryEditor(e)}>{hasPages ? "✎ 手書きを編集" : "✎ 手書きを追加"}</button>}
                <button className="btn text-xs min-h-9" onClick={() => setPrinting(e)}>印刷</button>
              </span>
            </div>
            <div className="text-xs text-stone-600">{Object.entries(e.record).filter(([, v]) => v).map(([f, v]) => `${f}:${v}`).join("　")}</div>
            {e.memo && <div className="text-xs mt-1">メモ：{e.memo}</div>}
            {e.next_proposal && <div className="text-xs mt-1 text-canopy">次回提案：{e.next_proposal}</div>}
            {e.health?.intake && e.health.intake.length > 0 && <IntakeList items={e.health.intake} title={`事前問診${e.health.booking_no ? `（${e.health.booking_no}）` : ""}`} />}
            {(photoOf(e.photos, "before").length > 0 || photoOf(e.photos, "after").length > 0) && <div className="grid grid-cols-2 gap-1 mt-1">
              {(["before", "after"] as const).map(kind => <div key={kind}><div className="text-[10px] text-stone-500">{kind === "before" ? "施術前" : "施術後"}</div>{photoOf(e.photos, kind).map(u => <a key={u} href={u} target="_blank" rel="noreferrer"><img src={u} alt={kind === "before" ? "施術前" : "施術後"} className="w-full aspect-square object-cover rounded border bg-stone-100" /></a>)}</div>)}
            </div>}
            <PageThumbs pages={shown} onOpen={i => setViewer({ entry: e, index: i })} />
          </div>; })}
        </div>
        <div className="max-md:contents">
          <div className="card mb-3 max-md:mb-0 scroll-mt-20 max-md:order-1" id="sec-visits" data-testid="visit-history"><div className="font-bold mb-1">来店履歴</div>
            {bookings.length === 0 && <div className="text-sm text-stone-400">まだありません</div>}
            {shownBookings.map(b => <div key={b.id} className={`text-sm border-t py-1 ${b === nextBooking ? "bg-emerald-50" : ""}`}>
              <div className="flex gap-2"><span className="whitespace-nowrap">{b.start_at.slice(0, 10)} {hm(b.start_at)}</span><span className="text-xs text-stone-500 self-center">{CHANNEL_LABEL[b.channel]}</span><span className="ml-auto text-xs self-center">{b === nextBooking ? "次のご予約" : STATUS_LABEL[b.status]}</span></div>
              {(menuOf(b) || staffName(b.staff_id)) && <div className="text-xs text-ink-soft">{menuOf(b)}{staffName(b.staff_id) ? `／${staffName(b.staff_id)}` : ""}</div>}
            </div>)}
            {bookings.length > SHOW_VISITS && <button type="button" className="btn-quiet text-xs w-full mt-1" onClick={() => setAllVisits(v => !v)}>{allVisits ? "少なく表示" : `すべて見る（${bookings.length}件）`}</button>}
          </div>
          {hist.length > 0 && <div className="card mb-3 max-md:mb-0 max-md:order-3" data-testid="hist-visits"><div className="font-bold mb-1">前のPOSの来店 <span className="text-xs font-normal text-ink-mute">（取り込み。売上には入りません）</span></div>
            {hist.filter(h => h.kind === 'summary').map(h => <div key={h.id} className="text-sm border-t py-1">まとめ（{IMPORT_SOURCE_LABEL[h.source]}）：{[h.first_visit_on && `初回 ${h.first_visit_on}`, h.last_visit_on && `最終 ${h.last_visit_on}`, h.visit_count != null && `${h.visit_count}回`, h.staff_name && `担当 ${h.staff_name}`].filter(Boolean).join("・")}</div>)}
            {hist.filter(h => h.kind === 'visit').slice(0, 50).map(h => <div key={h.id} className="text-sm border-t py-1 flex gap-2"><span className="whitespace-nowrap">{h.visited_on}</span><span className="text-xs text-ink-soft">{h.menu_text}</span><span className="text-xs text-ink-mute">{h.staff_name}</span><span className="ml-auto text-xs tabular-nums">{h.amount != null ? yen(h.amount) : ""}</span></div>)}
          </div>}
          <div className="card scroll-mt-20 max-md:order-4" id="sec-sales"><div className="font-bold mb-1">お会計履歴</div>
            {sales.map(s => <div key={s.id} className={`text-sm border-t py-1 ${s.status === 'voided' ? 'line-through text-stone-400' : ''}`}><div className="flex"><span>{s.sold_at.slice(0, 10)} {s.sale_no}</span><span className="ml-auto">{yen(s.total)}</span></div><div className="text-xs text-stone-500">{s.lines.map(l => l.name).join("・")}</div></div>)}
          </div>
        </div>
      </div>

      {editor && <HandwritingEditor title={`${c.name} 様　${editor.entry ? editor.entry.visited_on : k.visited_on}`} initial={editor.initial} builtins={builtins} templates={bgs} imagesReady={ready24}
        onCancel={() => setEditor(null)} onSave={onEditorSave} />}
      {viewer && <PageLightbox title={`${c.name} 様　${viewer.entry.visited_on}`} pages={shownOf(viewer.entry)} index={viewer.index} onClose={() => setViewer(null)}
        onEdit={ready10 ? () => openEntryEditor(viewer.entry) : undefined} onPrint={() => { setPrinting(viewer.entry); }} />}
      {printing && <PrintSheet imageCount={shownOf(printing).length} onDone={endPrint}>
        <h1>{c.name} 様　カルテ</h1>
        <div className="ps-meta">{printing.visited_on}　担当：{staffName(printing.staff_id) || "—"}　{TEMPLATES[printing.template]?.label || printing.template}</div>
        <div className="ps-meta">{Object.entries(printing.record).filter(([, v]) => v).map(([f, v]) => `${f}：${v}`).join("　")}</div>
        {printing.memo && <div className="ps-meta">メモ：{printing.memo}</div>}
        {printing.next_proposal && <div className="ps-meta">次回提案：{printing.next_proposal}</div>}
        {shownOf(printing).map((p, i) => p.url ? <div key={p.key} className="ps-page"><img src={p.url} alt="" /><div className="ps-cap">{p.label === "以前の手書き" ? "以前の手書き" : `手書き ${i + 1}ページ目`}</div></div> : null)}
      </PrintSheet>}
    </div>
  );
}
