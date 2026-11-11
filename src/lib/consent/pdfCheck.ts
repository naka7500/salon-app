// 同意書・問診票：PDF の「使ってよいか」の検査（画面を使わない部分。テストから直接呼べる）。
// 監査 2026-11-11 S1・S2 への対応：
//  - パスワード・編集制限つき（暗号化）の PDF は使わない（そのまま結合すると壊れた PDF ができる）
//  - 作った署名済み PDF は、保存の前にもう一度読み込んで確かめる
//  - 画面に描いた結果（文字のフォント・画像・白紙）を調べて、表示できていないページがあれば署名させない
import { PDFDocument } from "pdf-lib";

export const ENCRYPTED_PDF_MSG = "パスワードや編集制限のかかったPDFは使えません。制限を外すか、画像にして登録してください";
export const BROKEN_PDF_MSG = "このPDFは読み込めませんでした（壊れているか、対応していない形式です）。別のPDFにするか、画像にして登録してください";
export const VIEW_FAIL_MSG = "この書類は、この端末で正しく表示できませんでした。表示できない書類には署名を取れません。設定＞同意書・問診票 で、書類を画像（JPEG・PNG）にして登録し直してください";
export const OLD_DEVICE_MSG = "この端末（古い iPadOS・ブラウザ）ではPDFの書類を表示できません。署名は取れません。iPadOS を新しくするか、設定＞同意書・問診票 で書類を画像（JPEG・PNG）にして登録してください";
export const SIGNED_PDF_BROKEN_MSG = "署名済みのPDFを正しく作れませんでした。保存していません。設定＞同意書・問診票 で、書類を画像（JPEG・PNG）にして登録し直してください";
/** テンプレ（PDF）のページ数の上限。iPad の Safari は Canvas の合計に上限があるため */
export const CONSENT_MAX_PAGES = 30;
export const TOO_MANY_PAGES_MSG = `ページ数が多すぎます（${CONSENT_MAX_PAGES}ページまで）。分けて登録してください`;

export type ConsentPdfCode = "encrypted" | "broken" | "pages" | "view" | "old-device" | "signed-broken";
/** 同意書の PDF を「使えない」と判断したときのエラー（message はそのまま画面に出せる日本語） */
export class ConsentPdfError extends Error {
  code: ConsentPdfCode; page?: number;
  constructor(code: ConsentPdfCode, message: string, page?: number) { super(message); this.name = "ConsentPdfError"; this.code = code; this.page = page; }
}

const toBytes = async (src: Blob | ArrayBuffer | Uint8Array) => (src instanceof Uint8Array ? src : new Uint8Array(src instanceof ArrayBuffer ? src : await src.arrayBuffer()));

/** PDF の中に「暗号化（/Encrypt）」の印があるか。pdf-lib が読めない壊れた PDF でも、暗号化なら暗号化と伝えるための補助 */
function looksEncrypted(bytes: Uint8Array): boolean {
  const tail = bytes.subarray(Math.max(0, bytes.length - 4096));
  const has = (b: Uint8Array) => { const s = new TextDecoder("latin1").decode(b); return /\/Encrypt\b/.test(s); };
  return has(tail) || has(bytes.subarray(0, Math.min(bytes.length, 4096)));
}

/** テンプレの PDF を読み込む。暗号化（開くパスワード・編集制限）は断る。ignoreEncryption は使わない */
export async function loadTemplatePdf(src: Blob | ArrayBuffer | Uint8Array): Promise<PDFDocument> {
  const bytes = await toBytes(src);
  let doc: PDFDocument;
  try { doc = await PDFDocument.load(bytes, { updateMetadata: false }); }
  catch (e) {
    const m = String((e as Error)?.message || e);
    if (/encrypt/i.test(m) || looksEncrypted(bytes)) throw new ConsentPdfError("encrypted", ENCRYPTED_PDF_MSG);
    throw new ConsentPdfError("broken", BROKEN_PDF_MSG);
  }
  if (doc.isEncrypted) throw new ConsentPdfError("encrypted", ENCRYPTED_PDF_MSG);
  let n = 0;
  try { n = doc.getPageCount(); } catch { throw new ConsentPdfError("broken", BROKEN_PDF_MSG); }
  if (n < 1) throw new ConsentPdfError("broken", BROKEN_PDF_MSG);
  if (n > CONSENT_MAX_PAGES) throw new ConsentPdfError("pages", TOO_MANY_PAGES_MSG);
  return doc;
}

/** 登録の前・署名の前の検査：使える PDF ならページ数を返す。使えなければ ConsentPdfError */
export async function checkTemplatePdf(src: Blob | ArrayBuffer | Uint8Array): Promise<{ pages: number }> {
  return { pages: (await loadTemplatePdf(src)).getPageCount() };
}

/** 作った署名済み PDF を、保存の前にもう一度読み込んで確かめる（開けない物・ページが足りない物は保存しない） */
export async function verifySignedPdf(src: Blob | ArrayBuffer | Uint8Array, expectedPages: number): Promise<void> {
  const bytes = await toBytes(src);
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 8));
  if (!head.startsWith("%PDF-")) throw new ConsentPdfError("signed-broken", SIGNED_PDF_BROKEN_MSG);
  let n = -1;
  try {
    const doc = await PDFDocument.load(bytes, { updateMetadata: false });
    if (doc.isEncrypted) throw new Error("encrypted");
    n = doc.getPageCount();
    // 各ページの中身まで辿れること（/Root や /Pages が壊れていると、ここで落ちる）
    for (const p of doc.getPages()) { const { width, height } = p.getSize(); if (!(width > 0 && height > 0)) throw new Error("page"); }
  } catch { throw new ConsentPdfError("signed-broken", SIGNED_PDF_BROKEN_MSG); }
  if (n !== expectedPages) throw new ConsentPdfError("signed-broken", SIGNED_PDF_BROKEN_MSG);
}

export { sha256Hex } from "./hash";

// ---------------------------------------------------------------------------
// 画面に描いた結果の検査
// ---------------------------------------------------------------------------

/** 描いたページが「ほぼ白紙」か。RGBA の画素（Canvas の getImageData）を間引いて数える。
 *  白でない画素が全体の 0.02% 未満なら白紙とみなす（1行だけの書類でも 0.1% 以上になる） */
export function isBlankPixels(data: Uint8ClampedArray | Uint8Array, width: number, height: number, step = 2): boolean {
  let ink = 0, total = 0;
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const i = (y * width + x) * 4; total++;
      if (data[i + 3] > 16 && (data[i] < 236 || data[i + 1] < 236 || data[i + 2] < 236)) ink++;
    }
  }
  return total === 0 || ink / total < 0.0002;
}

export interface OpList { fnArray: ArrayLike<number>; argsArray: ArrayLike<unknown> }
export interface OpsTable { setFont: number; paintImageXObject: number; paintImageXObjectRepeat?: number; paintImageMaskXObject?: number; paintInlineImageXObject?: number }
export type PageProblem = { kind: "font" | "image"; id: string; detail: string };
export interface PageInspection { problems: PageProblem[]; /** 埋め込まれていないフォント（端末のフォントで代わりに描く）の名前 */ missingFonts: string[] }

/** pdf.js がページを描いた後に、そのページで使った「フォント」と「画像」が本当に用意できたかを調べる。
 *  pdf.js は読めないフォント・画像があっても警告だけで先へ進む（文字や画像が抜けたまま表示される）ので、ここで拾う。
 *  lookup(id)：pdf.js のページが持つ物（page.commonObjs / page.objs）。まだ用意できていない・失敗した物は undefined か null か文字列（エラー文） */
export function inspectPageOps(ops: OpList, OPS: OpsTable, lookup: (id: string) => unknown): PageInspection {
  const problems: PageProblem[] = []; const missing = new Set<string>(); const seen = new Set<string>();
  const imgFns = new Set([OPS.paintImageXObject, OPS.paintImageXObjectRepeat].filter((x): x is number => typeof x === "number"));
  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i]; const args = ops.argsArray[i] as unknown[] | null;
    const id = Array.isArray(args) && typeof args[0] === "string" ? args[0] : null;
    if (!id) continue;
    if (fn === OPS.setFont) {
      if (seen.has("f:" + id)) continue; seen.add("f:" + id);
      const o = lookup(id);
      if (!o || typeof o !== "object") { problems.push({ kind: "font", id, detail: typeof o === "string" ? o.slice(0, 120) : "not loaded" }); continue; }
      const f = o as { error?: unknown; missingFile?: boolean; name?: string };
      if (f.error) { problems.push({ kind: "font", id, detail: String(f.error).slice(0, 120) }); continue; }
      if (f.missingFile) missing.add(f.name || id);
    } else if (imgFns.has(fn)) {
      if (seen.has("i:" + id)) continue; seen.add("i:" + id);
      const o = lookup(id);
      if (!o || typeof o !== "object") problems.push({ kind: "image", id, detail: typeof o === "string" ? o.slice(0, 120) : "not decoded" });
    }
  }
  return { problems, missingFonts: [...missing] };
}

/** 日本語（ひらがな・カタカナ・漢字）を含むか */
export const hasJapanese = (s: string) => /[぀-ヿ㐀-鿿ｦ-ﾟ]/.test(s);
