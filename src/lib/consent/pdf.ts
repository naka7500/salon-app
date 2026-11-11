// 同意書・問診票（0025）：テンプレ（PDF・画像）を画面に出す／署名ページを足して1つのPDFにする。ブラウザだけで動かす（サーバに送らない）。
// - 画面表示：PDF は pdf.js で各ページを画像にする（iPad の Safari は iframe で PDF を全ページ出せないため）
// - 保存：pdf-lib で「テンプレの全ページ ＋ 署名ページ」のPDFを作る。署名ページは Canvas で描いた画像（日本語フォントを埋め込まなくて済む）
import { PDFDocument } from "pdf-lib";
import type { ConsentTemplateKind } from "@/lib/db";
import { resizeImage } from "@/components/karte/ink";
import { ConsentPdfError, BROKEN_PDF_MSG, ENCRYPTED_PDF_MSG, OLD_DEVICE_MSG, VIEW_FAIL_MSG, CONSENT_MAX_PAGES, TOO_MANY_PAGES_MSG, checkTemplatePdf, hasJapanese, inspectPageOps, isBlankPixels, loadTemplatePdf, verifySignedPdf } from "./pdfCheck";

export { ConsentPdfError } from "./pdfCheck";

/** 書類を画面に出した結果。pages＝各ページの画像（data URL）。warnings＝使えるが注意してほしいこと（登録画面で見せる） */
export interface RenderResult { pages: string[]; warnings: string[] }
export const FONT_WARN_MSG = "このPDFは日本語の文字のフォントが埋め込まれていません。端末によって文字の形が変わったり、出なかったりします。下の見本と、実際に使うタブレットの署名画面で、文字が全部見えるか確かめてください（心配なときは画像にして登録してください）";

const viewFail = (page?: number) => new ConsentPdfError("view", page ? `${VIEW_FAIL_MSG}（${page}ページ目）` : VIEW_FAIL_MSG, page);
function withTimeout<T>(p: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  return new Promise<T>((ok, ng) => { const t = setTimeout(() => ng(onTimeout()), ms); p.then(v => { clearTimeout(t); ok(v); }, e => { clearTimeout(t); ng(e); }); });
}

/** 表示用：テンプレの全ページを画像にする（PDF は幅 ~1400px で描く）。
 *  ★1ページでも「描けなかった・白紙に見える・文字や画像が欠けた」ら ConsentPdfError を投げる（監査 2026-11-11 S2・M1）。
 *    呼ぶ側は、この関数が最後まで成功したときだけ署名させること。
 *  onPage：描けたページから順に渡す（読み込み中の表示用。最後まで成功するまでは「表示できた」とみなさない） */
export async function renderTemplatePages(blob: Blob, kind: ConsentTemplateKind, onPage?: (url: string, index: number, total: number) => void): Promise<RenderResult> {
  if (kind === "image") {
    const u = await blobToDataUrl(blob);
    let img: HTMLImageElement;
    try { img = await loadImg(u); } catch { throw viewFail(1); }
    if (!img.naturalWidth || !img.naturalHeight) throw viewFail(1);
    const cv = document.createElement("canvas"); const sc = Math.min(1, 600 / Math.max(img.naturalWidth, img.naturalHeight));
    cv.width = Math.max(1, Math.round(img.naturalWidth * sc)); cv.height = Math.max(1, Math.round(img.naturalHeight * sc));
    const ctx = cv.getContext("2d"); if (!ctx) throw new ConsentPdfError("old-device", OLD_DEVICE_MSG);
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, cv.width, cv.height); ctx.drawImage(img, 0, 0, cv.width, cv.height);
    const blank = isBlankPixels(ctx.getImageData(0, 0, cv.width, cv.height).data, cv.width, cv.height, 1); cv.width = 0; cv.height = 0;
    if (blank) throw viewFail(1);
    onPage?.(u, 0, 1); return { pages: [u], warnings: [] };
  }
  // PDF：まず中身の検査（暗号化・壊れ・ページ数）。ここで断れば、何も表示しない
  const data = new Uint8Array(await blob.arrayBuffer());
  await checkTemplatePdf(data);
  const pdfjs = await loadPdfJs();
  const base = pdfAssetBase();
  let doc: Awaited<ReturnType<PdfJs["getDocument"]>["promise"]>;
  try {
    // data は pdf.js が worker へ渡して使えなくなるので、写しを渡す
    doc = await withTimeout(pdfjs.getDocument({
      data: data.slice(), isEvalSupported: false,
      // 自サーバに置いた部品（外部への通信なし）：日本語などの文字対応表・標準フォント・JPEG2000/色の変換
      cMapUrl: `${base}cmaps/`, cMapPacked: true, standardFontDataUrl: `${base}standard_fonts/`, wasmUrl: `${base}wasm/`, iccUrl: `${base}iccs/`,
    }).promise, 45_000, () => viewFail());
  } catch (e) {
    if (e instanceof ConsentPdfError) throw e;
    if ((e as { name?: string })?.name === "PasswordException") throw new ConsentPdfError("encrypted", ENCRYPTED_PDF_MSG);
    if ((e as { name?: string })?.name === "InvalidPDFException") throw new ConsentPdfError("broken", BROKEN_PDF_MSG);
    throw viewFail();
  }
  const out: string[] = []; let fontWarn = false;
  try {
    if (doc.numPages > CONSENT_MAX_PAGES) throw new ConsentPdfError("pages", TOO_MANY_PAGES_MSG);
    for (let i = 1; i <= doc.numPages; i++) {
      const u = await withTimeout((async () => {
        const page = await doc.getPage(i);
        const baseVp = page.getViewport({ scale: 1 });
        const scale = Math.min(2.5, 1400 / baseVp.width);
        const vp = page.getViewport({ scale });
        const cv = document.createElement("canvas"); cv.width = Math.round(vp.width); cv.height = Math.round(vp.height);
        const ctx = cv.getContext("2d"); if (!ctx) throw new ConsentPdfError("old-device", OLD_DEVICE_MSG);
        try {
          ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, cv.width, cv.height);
          await page.render({ canvasContext: ctx, viewport: vp, canvas: cv }).promise;
          // 1) このページで使ったフォント・画像が用意できたか（pdf.js は失敗しても警告だけで進む）
          const ops = await page.getOperatorList();
          const lookup = (id: string) => { const st = id.startsWith("g_") ? page.commonObjs : page.objs; try { return st.has(id) ? st.get(id) : undefined; } catch { return undefined; } };
          const insp = inspectPageOps(ops, pdfjs.OPS, lookup);
          if (insp.problems.length) throw viewFail(i);
          // 2) 埋め込まれていないフォントで日本語を描くページ：端末のフォントで代わりに描く。この端末に日本語のフォントが無ければ、文字が出ていない。
          //    （英数字だけの標準フォント＝Helvetica などは、どの端末でも代わりのフォントで描けるので注意は出さない）
          if (insp.missingFonts.length) {
            const text = (await page.getTextContent()).items.map(it => ("str" in it ? it.str : "")).join("");
            if (hasJapanese(text)) { if (!canDrawJapanese()) throw viewFail(i); fontWarn = true; }
          }
          // 3) ほぼ白紙に見えるページ（画像を読めなかったスキャンPDFなど）
          if (isBlankPixels(ctx.getImageData(0, 0, cv.width, cv.height).data, cv.width, cv.height)) throw viewFail(i);
          return cv.toDataURL("image/jpeg", 0.88);
        } finally { cv.width = 0; cv.height = 0; page.cleanup(); }   // Canvas のメモリを返す（iPad の Safari は合計に上限がある）
      })().catch(e => { throw e instanceof ConsentPdfError ? e : viewFail(i); }), 60_000, () => viewFail(i));
      out.push(u); onPage?.(u, i - 1, doc.numPages);
    }
  } finally { await doc.destroy().catch(() => {}); }
  return { pages: out, warnings: fontWarn ? [FONT_WARN_MSG] : [] };
}

/** 登録の前の検査（設定画面）：署名画面と同じ描き方で全ページを描いてみる。だめなら ConsentPdfError。見本（1ページ目）と注意を返す */
export async function validateTemplateFile(blob: Blob, kind: ConsentTemplateKind): Promise<{ preview: string; pages: number; warnings: string[] }> {
  const r = await renderTemplatePages(blob, kind);
  return { preview: r.pages[0], pages: r.pages.length, warnings: r.warnings };
}

/** pdf.js の部品（cMap・標準フォント・wasm・ICC）の置き場所。public/pdfjs/ に scripts/copy-pdfjs-assets.mjs が写す（自サーバ。CDN は使わない） */
function pdfAssetBase(): string { return new URL("/pdfjs/", window.location.origin).toString(); }

/** この端末が日本語の文字を描けるか（描けない端末では、ひらがなと漢字が同じ「□」になる） */
let JP_OK: boolean | null = null;
export function canDrawJapanese(): boolean {
  if (JP_OK !== null) return JP_OK;
  try {
    const draw = (ch: string) => { const cv = document.createElement("canvas"); cv.width = 48; cv.height = 48; const c = cv.getContext("2d", { willReadFrequently: true })!; c.fillStyle = "#fff"; c.fillRect(0, 0, 48, 48); c.fillStyle = "#000"; c.font = "32px sans-serif"; c.textBaseline = "top"; c.fillText(ch, 4, 4); return c.getImageData(0, 0, 48, 48).data; };
    const a = draw("あ"), b = draw("漢"), e = draw("\uffff");
    const same = (x: Uint8ClampedArray, y: Uint8ClampedArray) => { for (let i = 0; i < x.length; i += 4) if (x[i] !== y[i]) return false; return true; };
    const inked = (x: Uint8ClampedArray) => { for (let i = 0; i < x.length; i += 4) if (x[i] < 128) return true; return false; };
    JP_OK = inked(a) && inked(b) && !same(a, b) && !same(a, e);
  } catch { JP_OK = false; }
  return JP_OK;
}

type PdfJs = typeof import("pdfjs-dist");
let PDFJS: Promise<PdfJs> | null = null;
/** pdf.js はブラウザでだけ読み込む（worker も自サーバから）。
 *  ★「legacy」ビルドを使う：古い iPadOS の Safari に無い機能（Promise.withResolvers・URL.parse・Promise.try など）の埋め合わせ入り（監査 M1）。
 *  それでも動かない端末では ConsentPdfError（old-device）＝「この端末では表示できません。署名は取れません」 */
function loadPdfJs(): Promise<PdfJs> {
  if (!PDFJS) {
    PDFJS = (async () => {
      if (typeof window === "undefined" || typeof Worker === "undefined" || !document.createElement("canvas").getContext) throw new ConsentPdfError("old-device", OLD_DEVICE_MSG);
      try {
        const m = (await import("pdfjs-dist/legacy/build/pdf.mjs")) as unknown as PdfJs;
        m.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/legacy/build/pdf.worker.min.mjs", import.meta.url).toString();
        return m;
      } catch { throw new ConsentPdfError("old-device", OLD_DEVICE_MSG); }
    })();
    PDFJS.catch(() => { PDFJS = null; });
  }
  return PDFJS;
}

export interface SignatureInfo { title: string; storeName: string; companyName?: string | null; signerName: string; signedAt: Date; staffName?: string | null; appName?: string }

/** 署名ページ（A4縦・1240×1754px）を Canvas で描く → JPEG */
export async function drawSignaturePage(info: SignatureInfo, signature: HTMLImageElement | null): Promise<Blob> {
  const W = 1240, H = 1754; const cv = document.createElement("canvas"); cv.width = W; cv.height = H;
  const ctx = cv.getContext("2d")!;
  const F = "'Hiragino Sans', 'BIZ UDPGothic', 'Noto Sans JP', 'Yu Gothic', 'Meiryo', sans-serif";
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "#1d2823"; ctx.textBaseline = "alphabetic";
  const M = 110; let y = 170;
  ctx.font = `bold 44px ${F}`; ctx.fillText("署名", M, y); y += 26;
  ctx.strokeStyle = "#1d2823"; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(M, y); ctx.lineTo(W - M, y); ctx.stroke(); y += 70;
  const row = (label: string, value: string) => {
    ctx.font = `28px ${F}`; ctx.fillStyle = "#5d6a63"; ctx.fillText(label, M, y);
    ctx.font = `bold 34px ${F}`; ctx.fillStyle = "#1d2823"; ctx.fillText(fitText(ctx, value, W - M * 2 - 260), M + 260, y);
    ctx.strokeStyle = "#d8ddd9"; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(M, y + 22); ctx.lineTo(W - M, y + 22); ctx.stroke();
    y += 84;
  };
  row("書類", info.title);
  row("店舗", info.companyName && info.companyName !== info.storeName ? `${info.storeName}（${info.companyName}）` : info.storeName);
  row("お名前", `${info.signerName}　様`);
  row("日付", fmtDate(info.signedAt));
  if (info.staffName) row("担当", info.staffName);
  y += 20;
  // 確認のチェック
  ctx.strokeStyle = "#1d2823"; ctx.lineWidth = 3; ctx.strokeRect(M, y - 30, 36, 36);
  ctx.beginPath(); ctx.moveTo(M + 7, y - 12); ctx.lineTo(M + 16, y - 3); ctx.lineTo(M + 31, y - 24); ctx.lineWidth = 4; ctx.stroke();
  ctx.font = `30px ${F}`; ctx.fillStyle = "#1d2823"; ctx.fillText("内容を確認し、同意します", M + 56, y);
  y += 70;
  // 署名欄
  ctx.font = `26px ${F}`; ctx.fillStyle = "#5d6a63"; ctx.fillText("ご署名", M, y); y += 20;
  const bx = M, by = y, bw = W - M * 2, bh = 440;
  ctx.fillStyle = "#fafbfa"; ctx.fillRect(bx, by, bw, bh);
  ctx.strokeStyle = "#9aa6a0"; ctx.lineWidth = 2; ctx.strokeRect(bx, by, bw, bh);
  if (signature && signature.naturalWidth) {
    const sc = Math.min((bw - 60) / signature.naturalWidth, (bh - 60) / signature.naturalHeight);
    const dw = signature.naturalWidth * sc, dh = signature.naturalHeight * sc;
    ctx.drawImage(signature, bx + (bw - dw) / 2, by + (bh - dh) / 2, dw, dh);
  }
  y = by + bh + 60;
  ctx.font = `22px ${F}`; ctx.fillStyle = "#8a958f";
  ctx.fillText(`この書類は ${info.appName || "店舗のタブレット"} で、${fmtDateTime(info.signedAt)} に電子的に署名されました。`, M, y);
  return canvasBlob(cv, "image/jpeg", 0.9);
}

/** テンプレ（PDF か画像）の全ページ ＋ 署名ページ → 1つのPDF。
 *  ★暗号化（パスワード・編集制限）の PDF は断る（そのまま結合すると開けない PDF になる。監査 S1）。
 *  ★作った PDF は、返す前にもう一度読み込んで「テンプレのページ数＋1」か確かめる。だめなら ConsentPdfError（保存しない） */
export async function buildSignedPdf(template: Blob, kind: ConsentTemplateKind, signaturePage: Blob, info: SignatureInfo): Promise<Blob> {
  let doc: PDFDocument;
  if (kind === "pdf") {
    doc = await loadTemplatePdf(template);
    try { doc.getForm().flatten(); } catch {}
  } else {
    doc = await PDFDocument.create();
    await addImagePage(doc, template);
  }
  const before = doc.getPageCount();
  await addImagePage(doc, signaturePage);
  doc.setTitle(`${info.title} - ${info.signerName}`); doc.setProducer("salon-app"); doc.setCreationDate(info.signedAt); doc.setModificationDate(info.signedAt);
  const bytes = await doc.save({ useObjectStreams: true });
  await verifySignedPdf(bytes, before + 1);
  return new Blob([bytes as BlobPart], { type: "application/pdf" });
}

/** 画像を A4 の1ページとして足す（収まるように） */
async function addImagePage(doc: PDFDocument, blob: Blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const img = blob.type === "image/png" ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
  const A4 = [595.28, 841.89] as const;
  const landscape = img.width > img.height;
  const pw = landscape ? A4[1] : A4[0], ph = landscape ? A4[0] : A4[1];
  const page = doc.addPage([pw, ph]);
  const sc = Math.min(pw / img.width, ph / img.height);
  const w = img.width * sc, h = img.height * sc;
  page.drawImage(img, { x: (pw - w) / 2, y: (ph - h) / 2, width: w, height: h });
}

/** 画像（JPEG・PNG・HEICなど）→ JPEG に縮める（長い辺 max px。向きは EXIF に従う）。PDF はそのまま（中身の検査は validateTemplateFile で） */
export async function normalizeTemplateFile(file: File, max = 2000): Promise<{ blob: Blob; kind: ConsentTemplateKind }> {
  if (file.type === "application/pdf" || /\.pdf$/i.test(file.name)) return { blob: file.type === "application/pdf" ? file : new Blob([await file.arrayBuffer()], { type: "application/pdf" }), kind: "pdf" };
  return { blob: await resizeImage(file, max, 0.88), kind: "image" };
}

export function loadImg(src: string): Promise<HTMLImageElement> {
  return new Promise((ok, ng) => { const im = new Image(); im.onload = () => ok(im); im.onerror = () => ng(new Error("画像を読み込めませんでした")); im.src = src; });
}
function canvasBlob(cv: HTMLCanvasElement, type: string, q?: number): Promise<Blob> {
  return new Promise((ok, ng) => cv.toBlob(b => (b ? ok(b) : ng(new Error("画像を作れませんでした"))), type, q));
}
function blobToDataUrl(b: Blob): Promise<string> {
  return new Promise((ok, ng) => { const r = new FileReader(); r.onload = () => ok(String(r.result)); r.onerror = () => ng(r.error); r.readAsDataURL(b); });
}
function fitText(ctx: CanvasRenderingContext2D, s: string, max: number) {
  if (ctx.measureText(s).width <= max) return s;
  let t = s; while (t.length > 1 && ctx.measureText(t + "…").width > max) t = t.slice(0, -1);
  return t + "…";
}
// 日付・時刻は日本時間で出す（端末のタイムゾーンの設定に左右されない。監査 L7）
const JST = (d: Date) => { const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Tokyo", year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(d).map(x => [x.type, x.value])); return p as Record<"year" | "month" | "day" | "hour" | "minute", string>; };
export const fmtDate = (d: Date) => { const p = JST(d); return `${p.year}年${p.month}月${p.day}日`; };
export const fmtDateTime = (d: Date) => { const p = JST(d); return `${fmtDate(d)} ${p.hour.padStart(2, "0")}:${p.minute.padStart(2, "0")}`; };
/** ファイル名用（日本時間の YYYY-MM-DD） */
export const ymdJst = (d: Date) => { const p = JST(d); return `${p.year}-${p.month.padStart(2, "0")}-${p.day.padStart(2, "0")}`; };
