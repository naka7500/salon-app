// pdf.js の部品（日本語などの文字対応表 cMap・標準フォント・JPEG2000/色変換の wasm・ICC）を public/pdfjs/ に写す。
// 同意書・問診票の PDF を自サーバの部品だけで表示するため（CDN には取りに行かない。監査 2026-11-11 S2）。
// npm install の後・npm run dev／build の前に自動で動く（package.json の postinstall / predev / prebuild）。
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "node_modules", "pdfjs-dist");
const dst = join(root, "public", "pdfjs");
const DIRS = ["cmaps", "standard_fonts", "wasm", "iccs"];

if (!existsSync(join(src, "package.json"))) {
  console.warn("[copy-pdfjs-assets] node_modules/pdfjs-dist が見つかりません（npm install の後にもう一度動きます）");
  process.exit(0);
}
const version = JSON.parse(readFileSync(join(src, "package.json"), "utf8")).version;
const stamp = join(dst, "VERSION");
if (existsSync(stamp) && readFileSync(stamp, "utf8").trim() === version && DIRS.every(d => existsSync(join(dst, d)))) process.exit(0);

rmSync(dst, { recursive: true, force: true });
mkdirSync(dst, { recursive: true });
for (const d of DIRS) {
  if (!existsSync(join(src, d))) { console.error(`[copy-pdfjs-assets] pdfjs-dist/${d} がありません`); process.exit(1); }
  cpSync(join(src, d), join(dst, d), { recursive: true });
}
writeFileSync(stamp, version + "\n");
console.log(`[copy-pdfjs-assets] pdfjs-dist ${version} の部品を public/pdfjs/ に写しました`);
