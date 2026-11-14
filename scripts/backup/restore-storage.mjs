#!/usr/bin/env node
// backup-storage.mjs で書き出したファイルを、Supabase の Storage に戻す（復元の練習用の「別の空プロジェクト」に向けて使う）。
//   使い方： RESTORE_SUPABASE_URL=… RESTORE_SERVICE_ROLE_KEY=… node scripts/backup/restore-storage.mjs <バックアップのフォルダ> --yes
// ★本番に向けて流さない。変数の名前を本番用（SUPABASE_URL）と分けてあるのはそのため。すでにあるファイルは上書きしない（飛ばす）。
// 先に DB を戻しておくこと（バケット karte・consents の定義は DB の中にある）。
import { readFile } from "node:fs/promises";
import path from "node:path";

const url = process.env.RESTORE_SUPABASE_URL, key = process.env.RESTORE_SERVICE_ROLE_KEY, dir = process.argv[2];
if (!url || !key || !dir || !process.argv.includes("--yes")) { console.error("使い方：RESTORE_SUPABASE_URL=… RESTORE_SERVICE_ROLE_KEY=… node scripts/backup/restore-storage.mjs <バックアップのフォルダ> --yes"); process.exit(2); }
const { createClient } = await import("@supabase/supabase-js");
const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
const root = path.join(dir, "storage");
const { files } = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
let ok = 0, skipped = 0, ng = 0;
for (const f of files) {
  const buf = await readFile(path.join(root, f.bucket, f.path));
  const type = f.path.endsWith(".pdf") ? "application/pdf" : f.path.endsWith(".png") ? "image/png" : /\.jpe?g$/.test(f.path) ? "image/jpeg" : "application/octet-stream";
  const r = await client.storage.from(f.bucket).upload(f.path, buf, { contentType: type, upsert: false });
  if (!r.error) ok++; else if (/exists|Duplicate/i.test(r.error.message)) skipped++; else { ng++; console.error(`NG: ${f.bucket}/${f.path}：${r.error.message.slice(0, 120)}`); }
}
console.log(`戻した ${ok}件・もうあった ${skipped}件・失敗 ${ng}件（一覧 ${files.length}件）`);
process.exit(ng ? 1 : 0);
