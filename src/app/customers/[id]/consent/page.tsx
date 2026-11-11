"use client";
/* eslint-disable @next/next/no-img-element -- テンプレのページは data: URL（ブラウザの中で描いたもの） */
// 同意書・問診票に署名する画面（0025）。店のタブレットでお客様に見せる：テンプレ → 「内容を確認しました」 → お名前 → 指・ペンで署名 → 保存。
// 保存すると「テンプレの全ページ＋署名ページ」のPDFを作って、お客様の記録に残す（スタッフの役割でできる。閲覧のみの方は不可）。
import Link from "next/link";
import { useRouter } from "next/navigation";
import { forwardRef, use, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { getRepo, type ConsentDocument, type ConsentTemplate, type Customer, type Staff, type Store } from "@/lib/db";
import { buildSignedPdf, drawSignaturePage, fmtDate, loadImg, renderTemplatePages, ConsentPdfError } from "@/lib/consent/pdf";
import { VIEW_FAIL_MSG } from "@/lib/consent/pdfCheck";

interface View { tplId: string; pages: string[]; total: number; err: string; blob: Blob | null; shown: boolean }
const EMPTY_VIEW: View = { tplId: "", pages: [], total: 0, err: "", blob: null, shown: false };
/** 署名とみなす線の長さの合計（画面のpx）。点1つ・短い線だけでは署名にしない（監査 L4） */
const SIGN_MIN_LEN = 60;

export default function ConsentSignPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ t?: string }> }) {
  const { id } = use(params); const { t: tq } = use(searchParams);
  const repo = getRepo(); const router = useRouter();
  const [c, setC] = useState<Customer | null>(null);
  const [store, setStore] = useState<Store | null>(null);
  const [me, setMe] = useState<Staff | null>(null);
  const [tpls, setTpls] = useState<ConsentTemplate[] | null | undefined>(undefined);
  const [tplId, setTplId] = useState<string | null>(tq || null);
  // 読み込んだテンプレ（テンプレが変わると空に戻る）。shown＝全ページを最後まで正しく描けた（これが true のときだけ署名できる。監査 2026-11-11 S2・M1）
  const [view, setView] = useState<View>(EMPTY_VIEW);
  const [checked, setChecked] = useState(false);
  const [name, setName] = useState("");
  const [hasSig, setHasSig] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [done, setDone] = useState<null | { doc: ConsentDocument; url: string }>(null);
  const [now] = useState(() => new Date());
  const padRef = useRef<SignaturePadHandle>(null);

  useEffect(() => {
    repo.customer(id).then(cc => { setC(cc || null); setName(n => n || cc?.name || ""); });
    repo.store().then(setStore).catch(() => {});
    repo.me().then(setMe).catch(() => setMe(null));
    repo.consentTemplates().then(list => { setTpls(list); const act = (list || []).filter(x => x.active); if (act.length === 1) setTplId(x => x || act[0].id); }).catch(() => setTpls(null));
  }, [repo, id]);
  // 「使わない」にしたテンプレは、URL で指定されても使わない（監査 L3）
  const tpl = tpls?.find(x => x.id === tplId && x.active) || null;

  // テンプレを読み込んで、各ページを画像にする。1ページでも正しく描けなければ、書類は出さず・署名もさせない
  useEffect(() => {
    if (!tpl) return; let off = false; const tplId = tpl.id;
    const upd = (f: (v: View) => Partial<View>) => setView(v => { const base = v.tplId === tplId ? v : { ...EMPTY_VIEW, tplId }; return { ...base, ...f(base) }; });
    (async () => {
      try {
        const blob = await repo.consentFileBlob(tpl.file_path); if (off) return;
        const r = await renderTemplatePages(blob, tpl.kind, (u, i, n) => { if (off) return; upd(v => { const a = [...v.pages]; a[i] = u; return { pages: a, total: n }; }); });
        if (off) return;
        if (!r.pages.length || r.pages.some(u => !u)) throw new ConsentPdfError("view", VIEW_FAIL_MSG);
        upd(() => ({ blob, pages: r.pages, total: r.pages.length, shown: true }));
      } catch (e) {
        if (off) return;
        upd(() => ({ pages: [], total: 0, blob: null, shown: false, err: e instanceof ConsentPdfError ? e.message : ((e as Error).message || "テンプレを読み込めませんでした") }));
      }
    })();
    return () => { off = true; };
  }, [repo, tpl]);
  const { pages, total, err: loadErr, blob: tplBlob, shown } = view.tplId === tpl?.id ? view : EMPTY_VIEW;

  const canSave = !!tpl && !!c && shown && pages.length > 0 && checked && hasSig && name.trim().length > 0 && !busy && !!tplBlob && !loadErr;
  const isViewer = me?.role === "viewer" || me?.active === false;

  async function save() {
    if (!tpl || !c || !tplBlob || !shown) return;   // 書類を表示できていないときは保存しない
    setBusy(true); setMsg("");
    try {
      const sigBlob = await padRef.current?.toBlob(); if (!sigBlob) throw new Error("署名をしてください");
      const sigUrl = URL.createObjectURL(sigBlob); const sigImg = await loadImg(sigUrl).finally(() => URL.revokeObjectURL(sigUrl));
      const signedAt = new Date();
      const info = { title: tpl.title, storeName: store?.name || "", companyName: store?.company_legal_name || store?.company_name || null, signerName: name.trim(), signedAt, staffName: me?.name || null, appName: "サロン台帳" };
      const sigPage = await drawSignaturePage(info, sigImg);
      const pdf = await buildSignedPdf(tplBlob, tpl.kind, sigPage, info);
      const doc = await repo.addConsentDocument({ customer_id: c.id, template_id: tpl.id, signer_name: name.trim() }, pdf);   // 署名日時・担当はサーバが決める
      const urls = await repo.consentFileUrls([doc.file_path]).catch(() => ({} as Record<string, string>));
      setDone({ doc, url: urls[doc.file_path] || "" });
    } catch (e) { setMsg((e as Error).message || "保存できませんでした"); }
    finally { setBusy(false); }
  }

  const back = `/customers/${id}`;
  if (tpls === null) return <Shell title="同意書・問診票" back={back}><div className="card text-sm">同意書・問診票は準備中です（DB更新 0025 の後に使えます）。</div></Shell>;
  if (!c || tpls === undefined) return <Shell title="同意書・問診票" back={back}><div className="text-stone-500">読み込み中…</div></Shell>;
  if (isViewer) return <Shell title="同意書・問診票" back={back}><div className="card text-sm">閲覧のみの方は署名を取れません。スタッフの方にお願いしてください。</div></Shell>;
  if (done) return (
    <Shell title="同意書・問診票" back={back}>
      <div className="card max-w-xl mx-auto text-center space-y-3" data-testid="consent-done">
        <div className="text-2xl font-bold text-canopy">保存しました</div>
        <div className="text-sm text-ink-soft">{done.doc.template_title}　／　{done.doc.signer_name} 様　／　{fmtDate(new Date(done.doc.signed_at))}</div>
        <div className="flex flex-wrap justify-center gap-2 pt-2">
          {done.url && <a className="btn" href={done.url} target="_blank" rel="noreferrer">PDFを開く</a>}
          <button className="btn-primary" onClick={() => router.push(back)}>お客様のページに戻る</button>
        </div>
        <div className="text-xs text-ink-mute">お客様のページの「同意書・問診票」に残ります。</div>
      </div>
    </Shell>
  );
  if (!tpl) return (
    <Shell title="同意書・問診票" back={back}>
      <div className="card max-w-xl mx-auto space-y-2">
        <div className="font-bold">{c.name} 様　— どの書類に署名しますか？</div>
        {tpls.filter(t => t.active).length === 0 && <div className="text-sm text-ink-soft">使えるテンプレがありません。設定＞同意書・問診票 で追加してください（オーナー・店長）。</div>}
        {tpls.filter(t => t.active).map(t => <button key={t.id} className="btn w-full !justify-start text-left !min-h-14" onClick={() => { setTplId(t.id); router.replace(`${back}/consent?t=${t.id}`); }}>{t.title}<span className="ml-auto text-xs text-ink-mute">{t.kind === "pdf" ? "PDF" : "画像"}</span></button>)}
      </div>
    </Shell>
  );
  return (
    <Shell title={tpl.title} back={back} right={<span className="text-sm text-ink-soft">{c.name} 様</span>}>
      <div className="max-w-3xl mx-auto space-y-3" data-testid="consent-sign">
        {/* 書類 */}
        <div className="card !p-2 sm:!p-3">
          {loadErr && <div className="text-sm px-3 py-3 rounded border bg-red-50 border-red-300 text-red-900 space-y-1" role="alert" data-testid="consent-view-error">
            <div className="font-bold">書類を表示できません（署名は取れません）</div>
            <div>{loadErr}</div>
          </div>}
          {!loadErr && pages.length === 0 && <div className="text-sm text-ink-soft px-2 py-6 text-center">書類を読み込み中…</div>}
          {!loadErr && pages.length > 0 && !shown && <div className="text-xs text-ink-soft px-2 py-1" data-testid="consent-view-loading">書類を確かめています…（全部のページが表示されるまで、署名はできません）</div>}
          {pages.length > 0 && <div className="space-y-2">
            {Array.from({ length: Math.max(total, pages.length) }).map((_, i) => <div key={i} className="relative border border-line rounded bg-white overflow-hidden">
              {pages[i] ? <img src={pages[i]} alt={`${tpl.title} ${i + 1}ページ目`} className="w-full h-auto block" /> : <div className="aspect-[1/1.414] grid place-items-center text-xs text-ink-mute">読み込み中…</div>}
              {total > 1 && <span className="absolute right-2 bottom-2 chip bg-white/90 border border-line text-ink-soft">{i + 1} / {total}</span>}
            </div>)}
            {shown && <div className="sr-only" data-testid="consent-view-ok">{pages.length}</div>}
          </div>}
        </div>

        {/* 確認と署名（書類を表示できないときは出さない） */}
        {loadErr ? <div className="flex justify-end"><Link className="btn" href={back}>お客様のページに戻る</Link></div> : <div className="card space-y-3" data-testid="consent-form">
          <label className="flex items-center gap-3 text-base font-semibold cursor-pointer min-h-12"><input type="checkbox" className="w-7 h-7" checked={checked} onChange={e => setChecked(e.target.checked)} data-testid="consent-check" />上の内容を確認しました</label>
          <div className="grid sm:grid-cols-[1fr_auto] gap-2">
            <label className="block"><span className="lbl">お名前</span><input className="inp w-full text-lg" value={name} maxLength={60} onChange={e => setName(e.target.value)} data-testid="consent-name" /></label>
            <div className="block"><span className="lbl">日付</span><div className="inp bg-paper text-lg tabular-nums">{fmtDate(now)}</div></div>
          </div>
          <div>
            <div className="flex items-center mb-1"><span className="lbl !mb-0">ご署名（指・ペンで書いてください）</span><button type="button" className="btn text-xs ml-auto" onClick={() => { padRef.current?.clear(); setHasSig(false); }}>書き直す</button></div>
            <SignaturePad ref={padRef} onChange={setHasSig} />
          </div>
          {msg && <div className="text-sm px-3 py-2 rounded border bg-amber-50 border-amber-300 text-amber-900" role="status">{msg}</div>}
          <div className="flex flex-wrap items-center gap-2 justify-end">
            <span className="text-xs text-ink-mute mr-auto">店舗：{store?.name}{me ? `　担当：${me.name}` : ""}</span>
            <Link className="btn" href={back}>やめる</Link>
            <button className="btn-primary !min-h-12 px-6 text-base" disabled={!canSave} onClick={() => void save()} data-testid="consent-save">{busy ? "保存中…" : "署名して保存"}</button>
          </div>
          {!canSave && !busy && <div className="text-[11px] text-ink-mute text-right">{shown ? "「確認しました」にチェック・お名前・署名がそろうと保存できます。" : "書類が全部表示されるまで、保存できません。"}</div>}
        </div>}
      </div>
    </Shell>
  );
}

function Shell({ title, back, right, children }: { title: string; back: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div>
      <div className="flex items-center gap-2 mb-3">
        <Link className="btn" href={back}>‹ 戻る</Link>
        <h1 className="text-lg font-bold truncate">{title}</h1>
        <div className="ml-auto">{right}</div>
      </div>
      {children}
    </div>
  );
}

// ---- 署名欄（Canvas。指・Apple Pencil・マウス） ----
const inkLength = (ss: { x: number; y: number }[][]) => ss.reduce((n, s) => n + s.slice(1).reduce((m, p, i) => m + Math.hypot(p.x - s[i].x, p.y - s[i].y), 0), 0);
export interface SignaturePadHandle { clear: () => void; toBlob: () => Promise<Blob | null> }
const SignaturePad = forwardRef<SignaturePadHandle, { onChange: (has: boolean) => void }>(function SignaturePad({ onChange }, ref) {
  const cvRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const strokes = useRef<{ x: number; y: number }[][]>([]);
  const cur = useRef<{ x: number; y: number }[] | null>(null);
  const pid = useRef<number | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = wrapRef.current; if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el); return () => ro.disconnect();
  }, []);
  const redraw = useCallback(() => {
    const cv = cvRef.current; if (!cv) return; const ctx = cv.getContext("2d")!;
    const dpr = cv.width / Math.max(1, size.w);
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, cv.width, cv.height); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.strokeStyle = "#1d2823"; ctx.lineWidth = 3;
    for (const s of [...strokes.current, ...(cur.current ? [cur.current] : [])]) {
      if (s.length === 1) { ctx.beginPath(); ctx.arc(s[0].x, s[0].y, 1.6, 0, Math.PI * 2); ctx.fillStyle = "#1d2823"; ctx.fill(); continue; }
      ctx.beginPath(); ctx.moveTo(s[0].x, s[0].y);
      for (let i = 1; i < s.length; i++) { const m = { x: (s[i - 1].x + s[i].x) / 2, y: (s[i - 1].y + s[i].y) / 2 }; ctx.quadraticCurveTo(s[i - 1].x, s[i - 1].y, m.x, m.y); }
      ctx.lineTo(s[s.length - 1].x, s[s.length - 1].y); ctx.stroke();
    }
  }, [size.w]);
  useEffect(() => { redraw(); }, [redraw, size]);
  const pt = (e: React.PointerEvent) => { const r = cvRef.current!.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const down = (e: React.PointerEvent) => { if (pid.current !== null) return; pid.current = e.pointerId; try { (e.currentTarget as Element).setPointerCapture(e.pointerId); } catch {} cur.current = [pt(e)]; redraw(); e.preventDefault(); };
  const move = (e: React.PointerEvent) => { if (pid.current !== e.pointerId || !cur.current) return; const p = pt(e); const l = cur.current[cur.current.length - 1]; if (Math.hypot(p.x - l.x, p.y - l.y) < 0.7) return; cur.current.push(p); redraw(); };
  const up = (e: React.PointerEvent) => { if (pid.current !== e.pointerId) return; pid.current = null; if (cur.current) { strokes.current.push(cur.current); cur.current = null; } redraw(); onChange(inkLength(strokes.current) >= SIGN_MIN_LEN); };
  useImperativeHandle(ref, () => ({
    clear() { strokes.current = []; cur.current = null; redraw(); },
    async toBlob() {
      if (inkLength(strokes.current) < SIGN_MIN_LEN) return null;
      // 余白を切って、幅 1200px の透明PNGにする
      const pts = strokes.current.flat(); const pad = 12;
      const x0 = Math.min(...pts.map(p => p.x)) - pad, y0 = Math.min(...pts.map(p => p.y)) - pad, x1 = Math.max(...pts.map(p => p.x)) + pad, y1 = Math.max(...pts.map(p => p.y)) + pad;
      const w = Math.max(40, x1 - x0), h = Math.max(24, y1 - y0); const sc = 1200 / w;
      const cv = document.createElement("canvas"); cv.width = Math.round(w * sc); cv.height = Math.round(h * sc);
      const ctx = cv.getContext("2d")!; ctx.setTransform(sc, 0, 0, sc, -x0 * sc, -y0 * sc);
      ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.strokeStyle = "#1d2823"; ctx.lineWidth = 3;
      for (const s of strokes.current) { ctx.beginPath(); ctx.moveTo(s[0].x, s[0].y); for (let i = 1; i < s.length; i++) ctx.lineTo(s[i].x, s[i].y); if (s.length === 1) ctx.lineTo(s[0].x + 0.1, s[0].y); ctx.stroke(); }
      return new Promise<Blob | null>(ok => cv.toBlob(b => ok(b), "image/png"));
    },
  }), [redraw]);
  const dpr = typeof window !== "undefined" ? Math.min(3, window.devicePixelRatio || 1) : 1;
  return (
    <div ref={wrapRef} className="relative w-full h-56 sm:h-64 rounded border-2 border-dashed border-line-strong bg-white overflow-hidden" style={{ touchAction: "none" }} data-testid="signature-pad">
      <canvas ref={cvRef} width={Math.max(1, Math.round(size.w * dpr))} height={Math.max(1, Math.round(size.h * dpr))} className="absolute inset-0 w-full h-full touch-none" style={{ cursor: "crosshair" }}
        onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onContextMenu={e => e.preventDefault()} aria-label="署名欄" />
      <div className="absolute left-4 right-4 bottom-10 border-b border-line-strong pointer-events-none" />
      <div className="absolute left-4 bottom-3 text-xs text-ink-mute pointer-events-none">ここに署名</div>
    </div>
  );
});
