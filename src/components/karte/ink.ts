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

/** 背景＋手書きを1枚の画像に。写真の背景はJPEG（容量を抑える）、それ以外はPNG */
export async function flatten(ink: KarteInk, bg: HTMLImageElement | null, opacity: number, photo: boolean): Promise<Blob> {
  const cv = document.createElement("canvas"); cv.width = ink.w; cv.height = ink.h;
  const ctx = cv.getContext("2d")!;
  drawBackground(ctx, bg, opacity, ink.w, ink.h);
  drawAll(ctx, ink.items);
  return photo ? toBlob(cv, "image/jpeg", 0.85) : toBlob(cv, "image/png");
}

/** 写真の縮小（長い辺 max px、JPEG）。iPad の写真（4000px 前後）をそのまま上げない */
export async function resizeImage(file: Blob, max = 2000, quality = 0.85): Promise<Blob> {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    const sc = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const cv = document.createElement("canvas"); cv.width = Math.round(img.naturalWidth * sc); cv.height = Math.round(img.naturalHeight * sc);
    const ctx = cv.getContext("2d")!; ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, cv.width, cv.height); ctx.drawImage(img, 0, 0, cv.width, cv.height);
    return await toBlob(cv, "image/jpeg", quality);
  } finally { URL.revokeObjectURL(url); }
}

export function blobToDataUrl(b: Blob): Promise<string> {
  return new Promise((ok, ng) => { const r = new FileReader(); r.onload = () => ok(String(r.result)); r.onerror = () => ng(r.error); r.readAsDataURL(b); });
}
export async function dataUrlToBlob(u: string): Promise<Blob> { return (await fetch(u)).blob(); }
