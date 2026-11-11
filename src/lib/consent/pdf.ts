// 同意書・問診票（0025）：テンプレ（PDF・画像）を画面に出す／署名ページを足して1つのPDFにする。ブラウザだけで動かす（サーバに送らない）。
// - 画面表示：PDF は pdf.js で各ページを画像にする（iPad の Safari は iframe で PDF を全ページ出せないため）
// - 保存：pdf-lib で「テンプレの全ページ ＋ 署名ページ」のPDFを作る。署名ページは Canvas で描いた画像（日本語フォントを埋め込まなくて済む）
import { PDFDocument } from "pdf-lib";
import type { ConsentTemplateKind } from "@/lib/db";

/** 表示用：各ページの画像（data URL）。PDF は幅 ~1400px で描く */
export async function renderTemplatePages(blob: Blob, kind: ConsentTemplateKind, onPage?: (url: string, index: number, total: number) => void): Promise<string[]> {
  if (kind === "image") { const u = await blobToDataUrl(blob); onPage?.(u, 0, 1); return [u]; }
  const pdfjs = await loadPdfJs();
  const data = new Uint8Array(await blob.arrayBuffer());
  const doc = await pdfjs.getDocument({ data, isEvalSupported: false }).promise;
  const out: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(2.5, 1400 / base.width);
    const vp = page.getViewport({ scale });
    const cv = document.createElement("canvas"); cv.width = Math.round(vp.width); cv.height = Math.round(vp.height);
    const ctx = cv.getContext("2d")!; ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, cv.width, cv.height);
    await page.render({ canvasContext: ctx, viewport: vp, canvas: cv }).promise;
    const u = cv.toDataURL("image/jpeg", 0.88); out.push(u); onPage?.(u, i - 1, doc.numPages);
    page.cleanup();
  }
  await doc.destroy().catch(() => {});
  return out;
}

type PdfJs = typeof import("pdfjs-dist");
let PDFJS: Promise<PdfJs> | null = null;
/** pdf.js はブラウザでだけ読み込む（worker も同じ場所から） */
function loadPdfJs(): Promise<PdfJs> {
  if (!PDFJS) PDFJS = import("pdfjs-dist").then(m => {
    try { m.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString(); } catch {}
    return m;
  });
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

/** テンプレ（PDF か画像）の全ページ ＋ 署名ページ → 1つのPDF */
export async function buildSignedPdf(template: Blob, kind: ConsentTemplateKind, signaturePage: Blob, info: SignatureInfo): Promise<Blob> {
  let doc: PDFDocument;
  if (kind === "pdf") {
    try { doc = await PDFDocument.load(await template.arrayBuffer(), { ignoreEncryption: true, updateMetadata: false }); }
    catch { throw new Error("テンプレのPDFを読み込めませんでした。別のPDF（保護されていないもの）にするか、画像にして登録してください"); }
    try { doc.getForm().flatten(); } catch {}
  } else {
    doc = await PDFDocument.create();
    await addImagePage(doc, template);
  }
  await addImagePage(doc, signaturePage);
  doc.setTitle(`${info.title} - ${info.signerName}`); doc.setProducer("salon-app"); doc.setCreationDate(info.signedAt); doc.setModificationDate(info.signedAt);
  const bytes = await doc.save({ useObjectStreams: true });
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

/** 画像（JPEG・PNG・HEICなど）→ JPEG に縮める（長い辺 max px）。PDF はそのまま */
export async function normalizeTemplateFile(file: File, max = 2000): Promise<{ blob: Blob; kind: ConsentTemplateKind }> {
  if (file.type === "application/pdf" || /\.pdf$/i.test(file.name)) return { blob: file.type === "application/pdf" ? file : new Blob([await file.arrayBuffer()], { type: "application/pdf" }), kind: "pdf" };
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImg(url);
    const sc = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const cv = document.createElement("canvas"); cv.width = Math.round(img.naturalWidth * sc); cv.height = Math.round(img.naturalHeight * sc);
    const ctx = cv.getContext("2d")!; ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, cv.width, cv.height); ctx.drawImage(img, 0, 0, cv.width, cv.height);
    return { blob: await canvasBlob(cv, "image/jpeg", 0.88), kind: "image" };
  } catch { throw new Error("この画像は読み込めませんでした（JPEG・PNG にしてください）"); }
  finally { URL.revokeObjectURL(url); }
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
export const fmtDate = (d: Date) => `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
export const fmtDateTime = (d: Date) => `${fmtDate(d)} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
