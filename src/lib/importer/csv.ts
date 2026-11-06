// CSV の読み込み（文字コードの判定＋引用符・改行入りの列に対応）。中身はブラウザの中だけで扱い、ログには出さない。

export type CsvEncoding = "utf-8" | "utf-8-bom" | "shift_jis";
export const ENCODING_LABEL: Record<CsvEncoding, string> = { "utf-8": "UTF-8", "utf-8-bom": "UTF-8（BOMつき）", "shift_jis": "Shift_JIS（CP932）" };

/** バイト列 → 文字列。BOM があれば UTF-8、UTF-8 として正しく読めれば UTF-8、だめなら Shift_JIS（Windows の CP932） */
export function decodeCsvBytes(bytes: Uint8Array, force?: CsvEncoding): { text: string; encoding: CsvEncoding } {
  const hasBom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  const sjis = () => new TextDecoder("shift_jis").decode(bytes);
  if (force === "shift_jis") return { text: sjis(), encoding: "shift_jis" };
  if (force === "utf-8" || force === "utf-8-bom") return { text: new TextDecoder("utf-8").decode(hasBom ? bytes.subarray(3) : bytes), encoding: hasBom ? "utf-8-bom" : "utf-8" };
  if (hasBom) return { text: new TextDecoder("utf-8").decode(bytes.subarray(3)), encoding: "utf-8-bom" };
  try { return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), encoding: "utf-8" }; }
  catch { return { text: sjis(), encoding: "shift_jis" }; }
}

/** 区切り文字（カンマ・タブ・セミコロン）を1行目から推測 */
export function detectDelimiter(text: string): string {
  const first = text.split(/\r\n|\n|\r/, 1)[0] ?? "";
  const count = (d: string) => { let n = 0, q = false; for (const ch of first) { if (ch === '"') q = !q; else if (!q && ch === d) n++; } return n; };
  const c = [",", "\t", ";"].map(d => [d, count(d)] as const).sort((a, b) => b[1] - a[1]);
  return c[0][1] > 0 ? c[0][0] : ",";
}

/** RFC4180 風：引用符で囲まれた列の中のカンマ・改行・""（引用符そのもの）に対応。空行は捨てる */
export function parseCsv(text: string, delimiter = detectDelimiter(text)): string[][] {
  const rows: string[][] = []; let row: string[] = []; let f = ""; let q = false;
  const pushRow = () => { row.push(f); f = ""; if (row.some(x => x.trim() !== "")) rows.push(row); row = []; };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; }
      else f += ch;
    } else if (ch === '"' && f === "") q = true;
    else if (ch === delimiter) { row.push(f); f = ""; }
    else if (ch === "\r") { if (text[i + 1] === "\n") i++; pushRow(); }
    else if (ch === "\n") pushRow();
    else f += ch;
  }
  if (f !== "" || row.length) pushRow();
  return rows;
}

/** 見出し行を探す（最初の数行に「タイトル」などが入っているCSV向け）：空でない列が一番多い最初の行 */
export function findHeaderRow(rows: string[][], maxScan = 10): number {
  let best = 0, bestN = -1;
  for (let i = 0; i < Math.min(rows.length, maxScan); i++) { const n = rows[i].filter(x => x.trim() !== "").length; if (n > bestN) { best = i; bestN = n; } }
  return best;
}

export interface ParsedCsv { encoding: CsvEncoding; header: string[]; rows: string[][]; headerRow: number }
export function readCsv(bytes: Uint8Array, force?: CsvEncoding): ParsedCsv {
  const { text, encoding } = decodeCsvBytes(bytes, force);
  const all = parseCsv(text);
  const h = findHeaderRow(all);
  const header = (all[h] ?? []).map(x => x.trim());
  const rows = all.slice(h + 1).map(r => { const out = r.slice(0, Math.max(header.length, r.length)); while (out.length < header.length) out.push(""); return out; });
  return { encoding, header, rows, headerRow: h };
}
