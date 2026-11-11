// 手書きの描画・消しゴムの当たり判定・1枚の画像への書き出し・写真の縮小。外部ライブラリは使わない（Canvas だけ）。
import type { KarteStroke, KarteInk } from "@/lib/db";
import { PAGE_W, PAGE_H } from "@/lib/karteTemplates";

export const emptyInk = (): KarteInk => ({ v: 1, w: PAGE_W, h: PAGE_H, items: [] });

/** 筆圧 → 太さの倍率（筆圧の無いマウス・指は 0.5 として扱う） */
const pw = (w: number, p: number) => w * (0.45 + 1.1 * Math.max(0.05, Math.min(1, p)));

/** 線を1本描く（ctx はページ座標に合わせて変換済みのもの） */
export function drawStroke(ctx: CanvasRenderingContext2D, s: KarteStroke) {
  const p = s.p; const n = p.length / 3;
  if (n === 0) return;
  ctx.save();
  ctx.lineCap = "round"; ctx.lineJoin = "round";
  if (s.t === "hl") {
    // 蛍光ペン：太さ一定・半透明。1本の中で重なっても濃くならないよう1つのパスで描く
    ctx.globalAlpha = 0.32; ctx.globalCompositeOperation = "multiply";
    ctx.strokeStyle = s.c; ctx.lineWidth = s.w; ctx.lineCap = "butt";
    ctx.beginPath(); ctx.moveTo(p[0], p[1]);
    if (n === 1) ctx.lineTo(p[0] + 0.1, p[1]);
    for (let i = 1; i < n; i++) ctx.lineTo(p[i * 3], p[i * 3 + 1]);
    ctx.stroke(); ctx.restore(); return;
  }
  ctx.strokeStyle = s.c; ctx.fillStyle = s.c;
  if (n === 1) { ctx.beginPath(); ctx.arc(p[0], p[1], pw(s.w, p[2]) / 2, 0, Math.PI * 2); ctx.fill(); ctx.restore(); return; }
  // 中点を通る2次曲線でなめらかに。区間ごとに筆圧で太さを変える
  let mx = p[0], my = p[1];
  for (let i = 1; i < n; i++) {
    const x0 = p[(i - 1) * 3], y0 = p[(i - 1) * 3 + 1], x1 = p[i * 3], y1 = p[i * 3 + 1];
    const nx = (x0 + x1) / 2, ny = (y0 + y1) / 2;
    ctx.beginPath(); ctx.lineWidth = pw(s.w, (p[(i - 1) * 3 + 2] + p[i * 3 + 2]) / 2);
    ctx.moveTo(mx, my); ctx.quadraticCurveTo(x0, y0, nx, ny); ctx.stroke();
    mx = nx; my = ny;
  }
  ctx.beginPath(); ctx.moveTo(mx, my); ctx.lineTo(p[(n - 1) * 3], p[(n - 1) * 3 + 1]); ctx.stroke();
  ctx.restore();
}

export function drawAll(ctx: CanvasRenderingContext2D, items: KarteStroke[]) { for (const s of items) drawStroke(ctx, s); }

/** 点 (px,py) と線分の距離 */
function segDist(px: number, py: number, x0: number, y0: number, x1: number, y1: number) {
  const dx = x1 - x0, dy = y1 - y0; const l = dx * dx + dy * dy;
  let t = l ? ((px - x0) * dx + (py - y0) * dy) / l : 0; t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x0 + t * dx), py - (y0 + t * dy));
}
/** 消しゴム（線ごと消す）：(x,y) から r 以内に触れている線の番号 */
export function hitStrokes(items: KarteStroke[], x: number, y: number, r: number): number[] {
  const out: number[] = [];
  items.forEach((s, idx) => {
    const p = s.p; const n = p.length / 3; const rr = r + s.w / 2;
    if (n === 1) { if (Math.hypot(x - p[0], y - p[1]) <= rr) out.push(idx); return; }
    for (let i = 1; i < n; i++) if (segDist(x, y, p[(i - 1) * 3], p[(i - 1) * 3 + 1], p[i * 3], p[i * 3 + 1]) <= rr) { out.push(idx); return; }
  });
  return out;
}

export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((ok, ng) => { const im = new Image(); im.decoding = "async"; im.onload = () => ok(im); im.onerror = () => ng(new Error("画像を読み込めませんでした")); im.src = src; });
}

/** 背景を「収まるように（contain）」描く */
export function drawBackground(ctx: CanvasRenderingContext2D, img: HTMLImageElement | null, opacity: number, w = PAGE_W, h = PAGE_H) {
  ctx.save(); ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, w, h);
  if (img && img.naturalWidth) {
    const sc = Math.min(w / img.naturalWidth, h / img.naturalHeight);
    const dw = img.naturalWidth * sc, dh = img.naturalHeight * sc;
    ctx.globalAlpha = Math.max(0.05, Math.min(1, opacity));
    ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
  }
  ctx.restore();
}

function toBlob(cv: HTMLCanvasElement, type: string, q?: number): Promise<Blob> {
  return new Promise((ok, ng) => cv.toBlob(b => (b ? ok(b) : ng(new Error("画像を作れませんでした"))), type, q));
}

/** ページに置いた画像（0024）。座標はページ座標 */
export interface PlacedImage { img: HTMLImageElement; x: number; y: number; w: number; h: number }
/** 置いた画像を描く（背景の上・線の下） */
export function drawImages(ctx: CanvasRenderingContext2D, list: PlacedImage[]) {
  for (const p of list) { if (!p.img.naturalWidth || p.w <= 0 || p.h <= 0) continue; ctx.drawImage(p.img, p.x, p.y, p.w, p.h); }
}

/** 背景＋置いた画像＋手書きを1枚の画像に。写真の背景・置いた画像があるときはJPEG（容量を抑える）、それ以外はPNG */
export async function flatten(ink: KarteInk, bg: HTMLImageElement | null, opacity: number, photo: boolean, images: PlacedImage[] = []): Promise<Blob> {
  const cv = document.createElement("canvas"); cv.width = ink.w; cv.height = ink.h;
  const ctx = cv.getContext("2d")!;
  drawBackground(ctx, bg, opacity, ink.w, ink.h);
  drawImages(ctx, images);
  drawAll(ctx, ink.items);
  return photo || images.length ? toBlob(cv, "image/jpeg", 0.85) : toBlob(cv, "image/png");
}

/** 下書きのページに「残すもの」があるか：線・背景・置いた画像のどれか（監査 2026-11-11 M7：画像だけのページを捨てない） */
export function draftHasContent(d: { strokes: { items: unknown[] }; bg: { kind: string }; images?: unknown[] | null }): boolean {
  return d.strokes.items.length > 0 || d.bg.kind !== "none" || (d.images?.length ?? 0) > 0;
}

/** HEIC／HEIF（iPhone の写真の元の形式）か。Safari 以外のブラウザは読み込めないことが多い */
export function isHeic(file: { type?: string; name?: string }): boolean {
  return /image\/hei[cf]/i.test(file.type || "") || /\.hei[cf]$/i.test(file.name || "");
}
export const HEIC_MSG = "この写真（HEIC形式）は、このブラウザでは読み込めません。iPad・iPhone の Safari で選ぶか、JPEG・PNG にしてから選んでください";
export const IMAGE_READ_MSG = "この画像は読み込めませんでした（JPEG・PNG にしてください）";

/** 写真を「正しい向き」で読み込む。iPhone・iPad の写真は向きの情報（EXIF）を持つ。
 *  1) <img>：今のブラウザ（Safari 13.1〜・Chrome 81〜）は既定で EXIF の向きに従い、Canvas に描くときも回した後の向きになる
 *  2) だめなら createImageBitmap（imageOrientation: from-image を明示）
 *  HEIC は Safari なら読める（iPad・iPhone の「写真から選ぶ」は通常 JPEG に変えて渡す）。読めないブラウザでは、わかる言葉で断る */
export async function decodeImage(file: Blob & { name?: string }): Promise<{ src: CanvasImageSource; width: number; height: number; close: () => void }> {
  const url = URL.createObjectURL(file);
  try { const img = await loadImage(url); if (img.naturalWidth > 0 && img.naturalHeight > 0) return { src: img, width: img.naturalWidth, height: img.naturalHeight, close: () => URL.revokeObjectURL(url) }; }
  catch { /* createImageBitmap で試す */ }
  URL.revokeObjectURL(url);
  if (typeof createImageBitmap === "function") {
    try { const bm = await createImageBitmap(file, { imageOrientation: "from-image" }); if (bm.width > 0 && bm.height > 0) return { src: bm, width: bm.width, height: bm.height, close: () => bm.close() }; }
    catch { /* 下で断る */ }
  }
  throw new Error(isHeic(file) ? HEIC_MSG : IMAGE_READ_MSG);
}

/** 写真の縮小（長い辺 max px、JPEG）。iPad の写真（4000px 前後）をそのまま上げない。向き（EXIF）を直し、HEIC も読めるブラウザでは JPEG に変える */
export async function resizeImage(file: Blob & { name?: string }, max = 2000, quality = 0.85): Promise<Blob> {
  const d = await decodeImage(file);
  try {
    const sc = Math.min(1, max / Math.max(d.width, d.height));
    const cv = document.createElement("canvas"); cv.width = Math.max(1, Math.round(d.width * sc)); cv.height = Math.max(1, Math.round(d.height * sc));
    const ctx = cv.getContext("2d")!; ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, cv.width, cv.height); ctx.drawImage(d.src, 0, 0, cv.width, cv.height);
    const out = await toBlob(cv, "image/jpeg", quality); cv.width = 0; cv.height = 0;
    return out;
  } finally { d.close(); }
}

export function blobToDataUrl(b: Blob): Promise<string> {
  return new Promise((ok, ng) => { const r = new FileReader(); r.onload = () => ok(String(r.result)); r.onerror = () => ng(r.error); r.readAsDataURL(b); });
}
export async function dataUrlToBlob(u: string): Promise<Blob> { return (await fetch(u)).blob(); }
