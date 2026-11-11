import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { PDFDocument } from "pdf-lib";
import { checkTemplatePdf, loadTemplatePdf, verifySignedPdf, sha256Hex, isBlankPixels, inspectPageOps, hasJapanese, ConsentPdfError, ENCRYPTED_PDF_MSG, SIGNED_PDF_BROKEN_MSG, CONSENT_MAX_PAGES } from "@/lib/consent/pdfCheck";

// 監査 2026-11-11 S1・S2：同意書の PDF の検査（暗号化は断る／作った PDF は読み直して確かめる／描けなかったページを見つける）
const FX = path.resolve(__dirname, "fixtures/consent");
const fx = (n: string) => new Uint8Array(readFileSync(path.join(FX, n)));
const PDFJS_DIR = path.resolve(__dirname, "../../../node_modules/pdfjs-dist");

describe("S1：パスワード・編集制限つき（暗号化）の PDF", () => {
  it("ふつうの PDF は使える（ページ数が返る）", async () => {
    expect(await checkTemplatePdf(fx("normal.pdf"))).toEqual({ pages: 2 });
  });
  it("編集制限だけ（開くパスワードなし）の PDF は断る", async () => {
    await expect(checkTemplatePdf(fx("owner_enc.pdf"))).rejects.toMatchObject({ name: "ConsentPdfError", code: "encrypted", message: ENCRYPTED_PDF_MSG });
    expect(ENCRYPTED_PDF_MSG).toBe("パスワードや編集制限のかかったPDFは使えません。制限を外すか、画像にして登録してください");
  });
  it("開くパスワードつきの PDF も断る", async () => {
    await expect(checkTemplatePdf(fx("user_enc.pdf"))).rejects.toMatchObject({ code: "encrypted" });
  });
  it("PDF でないファイル・壊れたファイルは「読み込めません」", async () => {
    await expect(checkTemplatePdf(new TextEncoder().encode("これはPDFではありません"))).rejects.toMatchObject({ code: "broken" });
    await expect(checkTemplatePdf(fx("normal.pdf").subarray(0, 300))).rejects.toBeInstanceOf(ConsentPdfError);
  });
  it(`ページ数が多すぎる（${CONSENT_MAX_PAGES}ページ超）PDF は断る`, async () => {
    const d = await PDFDocument.create(); for (let i = 0; i < CONSENT_MAX_PAGES + 1; i++) d.addPage([200, 200]);
    await expect(checkTemplatePdf(await d.save())).rejects.toMatchObject({ code: "pages" });
  });
  it("暗号化 PDF を無理に結合した PDF（監査で再現した壊れ方）は、保存前の読み直しで止まる", async () => {
    // 監査前の実装（ignoreEncryption: true）と同じ作り方 → 開けない PDF ができる
    const bad = await PDFDocument.load(fx("owner_enc.pdf"), { ignoreEncryption: true, updateMetadata: false });
    bad.addPage([595, 842]);
    const bytes = await bad.save({ useObjectStreams: true });
    await expect(verifySignedPdf(bytes, 3)).rejects.toMatchObject({ code: "signed-broken", message: SIGNED_PDF_BROKEN_MSG });
  });
  it("正しく作った署名済み PDF は通る。ページ数が合わない・PDF でない物は止まる", async () => {
    const d = await loadTemplatePdf(fx("normal.pdf")); d.addPage([595.28, 841.89]);
    const bytes = await d.save({ useObjectStreams: true });
    await expect(verifySignedPdf(bytes, 3)).resolves.toBeUndefined();
    await expect(verifySignedPdf(bytes, 2)).rejects.toMatchObject({ code: "signed-broken" });
    await expect(verifySignedPdf(bytes.subarray(0, bytes.length - 200), 3)).rejects.toMatchObject({ code: "signed-broken" });
    await expect(verifySignedPdf(new Uint8Array([1, 2, 3]), 1)).rejects.toMatchObject({ code: "signed-broken" });
  });
  it("SHA-256 は16進64文字（同じ中身なら同じ値）", async () => {
    const h = await sha256Hex(new TextEncoder().encode("abc"));
    expect(h).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(await sha256Hex(new Blob([new TextEncoder().encode("abc")]))).toBe(h);
  });
});

describe("S2：表示できていないページを見つける", () => {
  const px = (w: number, h: number, ink: number) => { const d = new Uint8ClampedArray(w * h * 4).fill(255); for (let i = 0; i < ink; i++) { const k = (i * 2) * 4 * 2; d[k] = d[k + 1] = d[k + 2] = 0; } return d; };
  it("真っ白のページは「白紙」。文字がある程度あれば白紙ではない", () => {
    expect(isBlankPixels(px(400, 560, 0), 400, 560)).toBe(true);
    expect(isBlankPixels(px(400, 560, 3), 400, 560)).toBe(true);      // 点が数個だけ（ごみ）
    expect(isBlankPixels(px(400, 560, 400), 400, 560)).toBe(false);   // 1行ぶんくらいの文字
  });
  const OPS = { setFont: 37, paintImageXObject: 85, paintImageXObjectRepeat: 88 };
  it("フォントを読めなかった（エラー文が入っている）ページは問題あり", () => {
    const r = inspectPageOps({ fnArray: [37, 37], argsArray: [["g_d0_f1", 12], ["g_d0_f2", 12]] }, OPS, id => (id === "g_d0_f1" ? { name: "Helvetica", missingFile: false } : "Ensure that the `cMapUrl` and `cMapPacked` API parameters are provided."));
    expect(r.problems).toEqual([{ kind: "font", id: "g_d0_f2", detail: expect.stringContaining("cMapUrl") }]);
  });
  it("画像を読めなかった（null・未解決）ページは問題あり。読めた画像は問題なし", () => {
    const ops = { fnArray: [85, 85, 85], argsArray: [["img_p0_1", 10, 10], ["img_p0_2", 10, 10], ["img_p0_3", 10, 10]] };
    const r = inspectPageOps(ops, OPS, id => (id === "img_p0_1" ? { width: 10, height: 10 } : id === "img_p0_2" ? null : undefined));
    expect(r.problems.map(p => p.id)).toEqual(["img_p0_2", "img_p0_3"]);
  });
  it("埋め込まれていないフォントは「注意」として名前を返す（問題にはしない）", () => {
    const r = inspectPageOps({ fnArray: [37], argsArray: [["g_d0_f2", 12]] }, OPS, () => ({ name: "HeiseiKakuGo-W5", missingFile: true }));
    expect(r).toEqual({ problems: [], missingFonts: ["HeiseiKakuGo-W5"] });
  });
  it("日本語が入っているかの判定", () => { expect(hasJapanese("同意書 abc")).toBe(true); expect(hasJapanese("ｶﾅ")).toBe(true); expect(hasJapanese("Consent 123")).toBe(false); });

  // 本物の pdf.js（legacy ビルド）で、日本語フォント非埋め込みの PDF を読む：cMap の場所を渡さないと文字が出ない → 検出できること
  async function inspect(file: string, withAssets: boolean) {
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const opt: Record<string, unknown> = { data: fx(file), isEvalSupported: false, verbosity: 0 };
    if (withAssets) Object.assign(opt, { cMapUrl: `${PDFJS_DIR}/cmaps/`, cMapPacked: true, standardFontDataUrl: `${PDFJS_DIR}/standard_fonts/`, wasmUrl: `${PDFJS_DIR}/wasm/`, iccUrl: `${PDFJS_DIR}/iccs/` });
    const doc = await pdfjs.getDocument(opt).promise;
    try {
      const page = await doc.getPage(1); const ops = await page.getOperatorList();
      return inspectPageOps(ops, pdfjs.OPS, id => { const st = id.startsWith("g_") ? page.commonObjs : page.objs; try { return st.has(id) ? st.get(id) : undefined; } catch { return undefined; } });
    } finally { await doc.destroy(); }
  }
  it("日本語フォント非埋め込みの PDF：cMap を渡さないと「フォントの問題」になる（＝署名させない）", async () => {
    const r = await inspect("jp_cid.pdf", false);
    expect(r.problems.some(p => p.kind === "font")).toBe(true);
  });
  it("日本語フォント非埋め込みの PDF：自サーバの cMap・標準フォントを渡せば問題なし（注意だけ出る）", async () => {
    const r = await inspect("jp_cid.pdf", true);
    expect(r.problems).toEqual([]);
    expect(r.missingFonts.length).toBeGreaterThan(0);
  });
  it("ふつうの PDF は問題なし・注意なし", async () => {
    expect(await inspect("normal.pdf", true)).toEqual({ problems: [], missingFonts: [] });
  });
});

describe("pdf.js の部品は自サーバに置く（CDN を使わない）", () => {
  it("copy-pdfjs-assets が写す4つのフォルダが pdfjs-dist にある", async () => {
    const { existsSync } = await import("node:fs");
    for (const d of ["cmaps", "standard_fonts", "wasm", "iccs"]) expect(existsSync(path.join(PDFJS_DIR, d))).toBe(true);
    expect(existsSync(path.join(PDFJS_DIR, "legacy/build/pdf.worker.min.mjs"))).toBe(true);
  });
  it("表示のコードに外部の URL（CDN）が無く、legacy ビルドと /pdfjs/ を使い、ignoreEncryption を使っていない", () => {
    const src = readFileSync(path.resolve(__dirname, "../consent/pdf.ts"), "utf8");
    expect(src).not.toMatch(/https?:\/\//);
    expect(src).toMatch(/pdfjs-dist\/legacy\/build\/pdf\.mjs/);
    expect(src).toMatch(/"\/pdfjs\/"/);
    expect(src + readFileSync(path.resolve(__dirname, "../consent/pdfCheck.ts"), "utf8")).not.toMatch(/ignoreEncryption:\s*true/);
  });
  it("署名画面に <object> の代替表示が無い（CSP object-src 'none' で止まるため）", () => {
    const src = readFileSync(path.resolve(__dirname, "../../app/customers/[id]/consent/page.tsx"), "utf8");
    expect(src).not.toMatch(/<object\b/);
    expect(src).toMatch(/shown && pages\.length > 0 && checked/);   // 表示できたときだけ保存できる
  });
});
