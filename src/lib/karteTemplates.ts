// カルテの手書きの「標準の背景」。線画は全部このファイルで描いている（外部の画像は使わない）。
// ページの大きさはどれも PAGE_W × PAGE_H（A4横と同じ比率）。
export const PAGE_W = 1414;
export const PAGE_H = 1000;

export interface BuiltinTemplate { key: string; name: string; hint: string; svg: string }

const LINE = "#6f7b74";   // 主な線
const SOFT = "#b9c4bd";   // ガイド線
const TEXT = "#5d6a63";   // 文字
const F = `font-family="Hiragino Sans, 'BIZ UDPGothic', 'Noto Sans JP', 'Yu Gothic', sans-serif"`;
const r1 = (n: number) => Math.round(n * 10) / 10;
const svg = (body: string) => `<svg xmlns="http://www.w3.org/2000/svg" width="${PAGE_W}" height="${PAGE_H}" viewBox="0 0 ${PAGE_W} ${PAGE_H}"><rect width="100%" height="100%" fill="#ffffff"/>${body}</svg>`;
const text = (x: number, y: number, s: string, size = 22, anchor = "middle", color = TEXT, weight = "normal") => `<text x="${r1(x)}" y="${r1(y)}" ${F} font-size="${size}" fill="${color}" text-anchor="${anchor}" font-weight="${weight}">${s}</text>`;
const line = (x1: number, y1: number, x2: number, y2: number, color = SOFT, w = 1.5, dash = "") => `<line x1="${r1(x1)}" y1="${r1(y1)}" x2="${r1(x2)}" y2="${r1(y2)}" stroke="${color}" stroke-width="${w}"${dash ? ` stroke-dasharray="${dash}"` : ""} stroke-linecap="round"/>`;
const path = (d: string, color = LINE, w = 2.5, dash = "") => `<path d="${d}" fill="none" stroke="${color}" stroke-width="${w}"${dash ? ` stroke-dasharray="${dash}"` : ""} stroke-linecap="round" stroke-linejoin="round"/>`;
const rect = (x: number, y: number, w: number, h: number, color = SOFT, sw = 1.5, rx = 6) => `<rect x="${r1(x)}" y="${r1(y)}" width="${r1(w)}" height="${r1(h)}" rx="${rx}" fill="none" stroke="${color}" stroke-width="${sw}"/>`;
const title = (s: string) => text(40, 52, s, 26, "start", TEXT, "bold");

/** 2次ベジェ上の点と外向きの法線（上まぶた用：上向き） */
function quad(p0: number[], p1: number[], p2: number[], t: number) {
  const u = 1 - t;
  const x = u * u * p0[0] + 2 * u * t * p1[0] + t * t * p2[0];
  const y = u * u * p0[1] + 2 * u * t * p1[1] + t * t * p2[1];
  const dx = 2 * u * (p1[0] - p0[0]) + 2 * t * (p2[0] - p1[0]);
  const dy = 2 * u * (p1[1] - p0[1]) + 2 * t * (p2[1] - p1[1]);
  const len = Math.hypot(dx, dy) || 1;
  let nx = dy / len, ny = -dx / len;
  if (ny > 0) { nx = -nx; ny = -ny; }
  return { x, y, nx, ny };
}

/** 目の形（目頭・目尻・上まぶた・下まぶた・黒目） */
function eye(cx: number, cy: number, a: number, up: number, low: number) {
  const L = [cx - a, cy], R = [cx + a, cy];
  return {
    L, R, top: [cx, cy - up],
    svg: path(`M${L[0]} ${L[1]} Q${cx} ${cy - up} ${R[0]} ${R[1]}`, LINE, 3) + path(`M${L[0]} ${L[1]} Q${cx} ${cy + low} ${R[0]} ${R[1]}`, LINE, 2.2)
      + `<circle cx="${cx}" cy="${r1(cy - up * 0.1)}" r="${r1((up + low) * 0.23)}" fill="none" stroke="${SOFT}" stroke-width="1.5"/>`,
  };
}

// ---------- まつげ用（両目） ----------
function eyelashEyes() {
  let b = title("まつげ（両目）");
  b += text(PAGE_W - 40, 52, "お客様と向かい合った向き", 18, "end", "#8a958f");
  const ZONES = 5;
  const one = (cx: number, innerOnRight: boolean, label: string) => {
    const cy = 330, a = 230;
    const e = eye(cx, cy, a, 170, 95);
    let s = text(cx, 112, label, 26, "middle", TEXT, "bold") + e.svg;
    // まつげの位置ガイド（11本）と、目頭→目尻のゾーン番号
    for (let i = 0; i <= 10; i++) {
      const p = quad(e.L, e.top, e.R, 0.06 + i * 0.088);
      s += line(p.x + p.nx * 8, p.y + p.ny * 8, p.x + p.nx * 72, p.y + p.ny * 72, SOFT, 1.5, "4 5");
    }
    for (let z = 0; z < ZONES; z++) {
      const t = 0.12 + z * 0.19; const p = quad(e.L, e.top, e.R, innerOnRight ? 1 - t : t);
      s += `<circle cx="${r1(p.x + p.nx * 100)}" cy="${r1(p.y + p.ny * 100)}" r="15" fill="#ffffff" stroke="${SOFT}" stroke-width="1.5"/>` + text(p.x + p.nx * 100, p.y + p.ny * 100 + 7, String(z + 1), 18);
    }
    const [inner, outer] = innerOnRight ? [e.R, e.L] : [e.L, e.R];
    s += text(inner[0], cy + 58, "目頭", 20) + text(outer[0], cy + 58, "目尻", 20);
    // 下：ゾーンごとの記入欄
    const x0 = cx - a, w = a * 2, y0 = 470, rh = 52, lw = 92;
    const rows = ["長さ", "カール", "太さ", "本数"];
    s += rect(x0, y0, w, rh * (rows.length + 1));
    const cw = (w - lw) / ZONES;
    for (let z = 0; z < ZONES; z++) { const n = innerOnRight ? ZONES - z : z + 1; s += text(x0 + lw + cw * z + cw / 2, y0 + 34, String(n), 18); }
    rows.forEach((r, i) => { s += line(x0, y0 + rh * (i + 1), x0 + w, y0 + rh * (i + 1)) + text(x0 + 14, y0 + rh * (i + 1) + 34, r, 18, "start"); });
    s += line(x0 + lw, y0, x0 + lw, y0 + rh * (rows.length + 1));
    for (let z = 1; z < ZONES; z++) s += line(x0 + lw + cw * z, y0, x0 + lw + cw * z, y0 + rh * (rows.length + 1), SOFT, 1);
    return s;
  };
  b += one(380, true, "右目") + one(1034, false, "左目");
  b += text(40, 800, "メモ", 20, "start");
  for (let i = 0; i < 3; i++) b += line(40, 840 + i * 52, PAGE_W - 40, 840 + i * 52, SOFT, 1.2);
  return svg(b);
}

// ---------- まつげデザイン（長さ・カールの配置） ----------
function eyelashDesign() {
  let b = title("まつげデザイン");
  b += text(PAGE_W - 40, 52, "目頭 → 目尻（左右共通）", 18, "end", "#8a958f");
  const cx = 707, cy = 440, a = 470;
  const e = eye(cx, cy, a, 270, 120);
  b += e.svg;
  const Z = 7;
  for (let z = 0; z < Z; z++) {
    const t = 0.08 + z * (0.84 / (Z - 1));
    const p = quad(e.L, e.top, e.R, t);
    b += line(p.x + p.nx * 10, p.y + p.ny * 10, p.x + p.nx * 92, p.y + p.ny * 92, SOFT, 1.5, "4 5");
    const bx = p.x + p.nx * 150, by = p.y + p.ny * 150;
    b += rect(bx - 58, by - 44, 116, 88, SOFT, 1.5, 8) + text(bx, by - 52, String(z + 1), 18, "middle", TEXT, "bold")
      + text(bx - 50, by - 16, "長さ", 14, "start", "#8a958f") + text(bx - 50, by + 10, "カール", 14, "start", "#8a958f") + text(bx - 50, by + 36, "太さ", 14, "start", "#8a958f");
  }
  b += text(e.L[0] - 6, cy + 54, "目頭", 22) + text(e.R[0] + 6, cy + 54, "目尻", 22);
  // 下：表
  const x0 = 40, w = PAGE_W - 80, y0 = 640, rh = 54, lw = 210;
  const rows = ["長さ（mm）", "カール（J・C・CC・D）", "太さ", "本数"];
  b += rect(x0, y0, w, rh * (rows.length + 1));
  const cw = (w - lw) / Z;
  b += text(x0 + 14, y0 + 35, "ゾーン", 18, "start");
  for (let z = 0; z < Z; z++) b += text(x0 + lw + cw * z + cw / 2, y0 + 35, String(z + 1), 18);
  rows.forEach((r, i) => { b += line(x0, y0 + rh * (i + 1), x0 + w, y0 + rh * (i + 1)) + text(x0 + 14, y0 + rh * (i + 1) + 35, r, 17, "start"); });
  b += line(x0 + lw, y0, x0 + lw, y0 + rh * (rows.length + 1));
  for (let z = 1; z < Z; z++) b += line(x0 + lw + cw * z, y0, x0 + lw + cw * z, y0 + rh * (rows.length + 1), SOFT, 1);
  b += text(x0, 965, "デザイン：□ナチュラル　□キュート　□セクシー　□クール　□その他（　　　　　）", 19, "start");
  return svg(b);
}

// ---------- ヘッドスパ用（頭皮マップ） ----------
/** 横顔（左向き）。cx は頭の中心 */
function profileLeft(cx: number) {
  const d = `M${cx - 92} ${236} C${cx - 60} ${168} ${cx + 70} ${160} ${cx + 118} ${250} C${cx + 146} ${304} ${cx + 128} ${380} ${cx + 82} ${430}`
    + ` C${cx + 70} ${448} ${cx + 66} ${480} ${cx + 70} ${520}`
    + ` M${cx - 92} ${236} C${cx - 112} ${268} ${cx - 116} ${300} ${cx - 112} ${326} L${cx - 138} ${372} L${cx - 112} ${384}`
    + ` C${cx - 116} ${398} ${cx - 122} ${404} ${cx - 116} ${414} C${cx - 120} ${428} ${cx - 112} ${448} ${cx - 92} ${456}`
    + ` C${cx - 60} ${464} ${cx - 38} ${458} ${cx - 30} ${468} L${cx - 26} ${520}`;
  const ear = `<ellipse cx="${cx + 14}" cy="350" rx="22" ry="36" fill="none" stroke="${LINE}" stroke-width="2.2"/>`;
  const hair = path(`M${cx - 86} ${250} C${cx - 64} ${276} ${cx - 34} ${292} ${cx - 16} ${318} C${cx - 4} ${336} ${cx - 10} ${384} ${cx + 22} ${400} C${cx + 44} ${410} ${cx + 62} ${420} ${cx + 76} ${432}`, SOFT, 2, "6 6");
  return path(d) + ear + hair;
}
function headspa() {
  let b = title("ヘッドスパ（頭皮マップ）");
  b += text(PAGE_W - 40, 52, "気になる所に印・メモ", 18, "end", "#8a958f");
  const cols = [190, 530, 880, 1225];
  // 上から
  { const cx = cols[0], cy = 340;
    b += text(cx, 116, "上から", 24, "middle", TEXT, "bold") + text(cx, 160, "前", 16, "middle", "#8a958f");
    b += `<ellipse cx="${cx}" cy="${cy}" rx="122" ry="152" fill="none" stroke="${LINE}" stroke-width="2.5"/>`;
    b += path(`M${cx - 12} ${cy - 150} L${cx} ${cy - 172} L${cx + 12} ${cy - 150}`, LINE, 2.2);
    b += path(`M${cx - 122} ${cy - 14} c-18 4 -18 40 0 44`, LINE, 2.2) + path(`M${cx + 122} ${cy - 14} c18 4 18 40 0 44`, LINE, 2.2);
    b += line(cx, cy - 150, cx, cy + 150, SOFT, 1.5, "6 6") + path(`M${cx - 112} ${cy - 62} Q${cx} ${cy - 92} ${cx + 112} ${cy - 62}`, SOFT, 1.5, "6 6") + path(`M${cx - 112} ${cy + 64} Q${cx} ${cy + 40} ${cx + 112} ${cy + 64}`, SOFT, 1.5, "6 6");
    b += `<circle cx="${cx + 18}" cy="${cy + 22}" r="16" fill="none" stroke="${SOFT}" stroke-width="1.5"/>`;
    b += text(cx, cy - 104, "前頭部", 15, "middle", "#8a958f") + text(cx - 52, cy + 8, "頭頂部", 15, "middle", "#8a958f") + text(cx + 40, cy + 64, "つむじ", 13, "start", "#8a958f") + text(cx, cy + 112, "後頭部", 15, "middle", "#8a958f"); }
  // 後ろから
  { const cx = cols[1], cy = 320;
    b += text(cx, 116, "後ろから", 24, "middle", TEXT, "bold");
    b += path(`M${cx - 58} ${cy + 128} C${cx - 140} ${cy + 90} ${cx - 138} ${cy - 150} ${cx} ${cy - 150} C${cx + 138} ${cy - 150} ${cx + 140} ${cy + 90} ${cx + 58} ${cy + 128} L${cx + 62} ${cy + 200} M${cx - 58} ${cy + 128} L${cx - 62} ${cy + 200}`);
    b += path(`M${cx - 122} ${cy + 6} c-20 4 -20 46 0 52`, LINE, 2.2) + path(`M${cx + 122} ${cy + 6} c20 4 20 46 0 52`, LINE, 2.2);
    b += line(cx, cy - 150, cx, cy + 120, SOFT, 1.5, "6 6") + path(`M${cx - 120} ${cy - 30} Q${cx} ${cy - 2} ${cx + 120} ${cy - 30}`, SOFT, 1.5, "6 6") + path(`M${cx - 70} ${cy + 104} Q${cx} ${cy + 120} ${cx + 70} ${cy + 104}`, SOFT, 1.5, "6 6");
    b += text(cx, cy - 70, "頭頂部", 15, "middle", "#8a958f") + text(cx, cy + 58, "後頭部", 15, "middle", "#8a958f") + text(cx, cy + 150, "えり足", 15, "middle", "#8a958f"); }
  // 左・右（横顔）
  b += text(cols[2], 116, "左側", 24, "middle", TEXT, "bold") + profileLeft(cols[2]) + text(cols[2] + 40, 290, "側頭部", 15, "middle", "#8a958f");
  b += text(cols[3], 116, "右側", 24, "middle", TEXT, "bold") + `<g transform="translate(${cols[3] * 2} 0) scale(-1 1)">${profileLeft(cols[3])}</g>` + text(cols[3] - 40, 290, "側頭部", 15, "middle", "#8a958f");
  // 下：状態とメモ
  const y0 = 600;
  b += line(40, y0 - 20, PAGE_W - 40, y0 - 20, SOFT, 1.2);
  b += text(40, y0 + 22, "頭皮：□健康　□乾燥　□脂性　□赤み　□硬い　　抜け毛：□少ない　□普通　□多い　　かゆみ：□なし　□少し　□あり", 19, "start");
  b += text(40, y0 + 74, "メモ", 19, "start");
  for (let i = 0; i < 5; i++) b += line(40, y0 + 112 + i * 52, PAGE_W - 40, y0 + 112 + i * 52, SOFT, 1.2);
  return svg(b);
}

// ---------- 顔（正面） ----------
function faceFront() {
  let b = title("顔（正面）");
  b += text(PAGE_W - 40, 52, "お客様と向かい合った向き", 18, "end", "#8a958f");
  const cx = 707, cy = 500;
  // 輪郭
  b += path(`M${cx - 200} ${cy - 120} C${cx - 206} ${cy - 330} ${cx + 206} ${cy - 330} ${cx + 200} ${cy - 120} C${cx + 198} ${cy + 90} ${cx + 120} ${cy + 286} ${cx} ${cy + 290} C${cx - 120} ${cy + 286} ${cx - 198} ${cy + 90} ${cx - 200} ${cy - 120} Z`, LINE, 3);
  // 生え際
  b += path(`M${cx - 196} ${cy - 150} C${cx - 150} ${cy - 220} ${cx - 40} ${cy - 236} ${cx} ${cy - 210} C${cx + 40} ${cy - 236} ${cx + 150} ${cy - 220} ${cx + 196} ${cy - 150}`, SOFT, 2, "6 6");
  // 耳
  b += path(`M${cx - 200} ${cy - 40} c-38 -10 -44 80 -8 104`, LINE, 2.4) + path(`M${cx + 200} ${cy - 40} c38 -10 44 80 8 104`, LINE, 2.4);
  // 眉・目
  for (const s of [-1, 1]) {
    const ex = cx + s * 92;
    b += path(`M${ex - s * 62} ${cy - 66} Q${ex} ${cy - 96} ${ex + s * 66} ${cy - 74}`, LINE, 4);
    b += path(`M${ex - 50} ${cy - 18} Q${ex} ${cy - 54} ${ex + 50} ${cy - 18} Q${ex} ${cy + 4} ${ex - 50} ${cy - 18} Z`, LINE, 2.4);
    b += `<circle cx="${ex}" cy="${cy - 22}" r="14" fill="none" stroke="${SOFT}" stroke-width="1.5"/>`;
  }
  // 鼻・口
  b += path(`M${cx - 10} ${cy - 20} L${cx - 14} ${cy + 70} M${cx - 34} ${cy + 86} Q${cx} ${cy + 104} ${cx + 34} ${cy + 86}`, LINE, 2.2);
  b += path(`M${cx - 60} ${cy + 164} Q${cx - 20} ${cy + 148} ${cx} ${cy + 156} Q${cx + 20} ${cy + 148} ${cx + 60} ${cy + 164} Q${cx} ${cy + 196} ${cx - 60} ${cy + 164} Z`, LINE, 2.2);
  // 首
  b += path(`M${cx - 100} ${cy + 250} L${cx - 108} ${cy + 340} M${cx + 100} ${cy + 250} L${cx + 108} ${cy + 340}`, LINE, 2.2);
  // 中心線・三等分のガイド
  b += line(cx, cy - 300, cx, cy + 300, SOFT, 1.2, "4 8");
  for (const y of [cy - 70, cy + 90]) b += line(cx - 230, y, cx + 230, y, SOFT, 1.2, "4 8");
  b += text(cx - 300, cy - 300, "右", 22, "middle", TEXT, "bold") + text(cx + 300, cy - 300, "左", 22, "middle", TEXT, "bold");
  // 左右のメモ欄
  for (const x0 of [40, PAGE_W - 40 - 330]) { b += text(x0, 180, "メモ", 19, "start"); for (let i = 0; i < 12; i++) b += line(x0, 220 + i * 56, x0 + 330, 220 + i * 56, SOFT, 1.2); }
  return svg(b);
}

let CACHE: BuiltinTemplate[] | null = null;
export function builtinTemplates(): BuiltinTemplate[] {
  if (!CACHE) CACHE = [
    { key: "eyelash-eyes", name: "まつげ用（両目）", hint: "目元・まつげの位置・目頭／目尻", svg: eyelashEyes() },
    { key: "eyelash-design", name: "まつげデザイン", hint: "ゾーンごとの長さ・カール・太さ", svg: eyelashDesign() },
    { key: "headspa", name: "ヘッドスパ用（頭皮マップ）", hint: "上・後ろ・左右", svg: headspa() },
    { key: "face-front", name: "顔（正面）", hint: "眉・目元・肌のメモ", svg: faceFront() },
  ];
  return CACHE;
}
/** 業態で並べ替え（最初に出したい物を先に） */
export function builtinOrder(businessType?: string): string[] {
  if (businessType === "headspa") return ["headspa", "face-front", "eyelash-eyes", "eyelash-design"];
  if (businessType === "hair") return ["headspa", "face-front", "eyelash-eyes", "eyelash-design"];
  return ["eyelash-eyes", "eyelash-design", "face-front", "headspa"];
}
export function builtinByKey(key: string) { return builtinTemplates().find(t => t.key === key); }
export function builtinDataUrl(key: string) { const t = builtinByKey(key); return t ? "data:image/svg+xml;charset=utf-8," + encodeURIComponent(t.svg) : ""; }
