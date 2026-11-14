#!/usr/bin/env node
// Storage（非公開バケット karte＝カルテ画像・consents＝署名済み同意書）の中身を、フォルダにまるごと書き出す。読むだけ（本番には何も書かない・消さない）。
//   使い方： SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… node scripts/backup/backup-storage.mjs [出力フォルダ]
//   出力：   <出力フォルダ>/storage/<バケット>/<元のパス> と、一覧 <出力フォルダ>/storage/manifest.json（パス・大きさ・SHA-256）
// ※DB のバックアップ（Supabase の自動バックアップも）には、ファイルの中身は入らない。だからこれが要る。
// ※サービスキーは秘密。環境変数で渡す（ファイル・コマンド履歴・ログに書かない）。このスクリプトも鍵やファイル名以外の中身を表示しない。
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const BUCKETS = ["karte", "consents"];

/** バケットの中のファイルを全部たどる（フォルダは id が無い） */
export async function listAll(client, bucket, prefix = "") {
  const out = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await client.storage.from(bucket).list(prefix, { limit: 1000, offset, sortBy: { column: "name", order: "asc" } });
    if (error) throw new Error(`${bucket}/${prefix} の一覧に失敗：${error.message}`);
    for (const e of data || []) {
      const p = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.id === null || e.id === undefined) out.push(...(await listAll(client, bucket, p)));
      else out.push({ path: p, size: e.metadata?.size ?? null });
    }
    if (!data || data.length < 1000) break;
  }
  return out;
}

/** ファイル名に「..」や絶対パスが入っていても、出力フォルダの外に書かない */
export function safeJoin(root, rel) {
  const full = path.resolve(root, rel);
  if (full !== path.resolve(root) && !full.startsWith(path.resolve(root) + path.sep)) throw new Error(`書き出せないパスです：${rel}`);
  return full;
}

/** 1つのバケットを書き出す。戻り値＝一覧（パス・大きさ・SHA-256） */
export async function backupBucket(client, bucket, outDir, io = { mkdir, writeFile }) {
  const files = await listAll(client, bucket);
  const manifest = [];
  for (const f of files) {
    const { data, error } = await client.storage.from(bucket).download(f.path);
    if (error || !data) throw new Error(`${bucket}/${f.path} のダウンロードに失敗：${error?.message || "空"}`);
    const buf = Buffer.from(await data.arrayBuffer());
    if (f.size !== null && f.size !== buf.length) throw new Error(`${bucket}/${f.path} の大きさが合いません（一覧 ${f.size}・実際 ${buf.length}）`);
    const dest = safeJoin(path.join(outDir, bucket), f.path);
    await io.mkdir(path.dirname(dest), { recursive: true });
    await io.writeFile(dest, buf);
    manifest.push({ bucket, path: f.path, size: buf.length, sha256: createHash("sha256").update(buf).digest("hex") });
  }
  return manifest;
}

async function main() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) { console.error("SUPABASE_URL と SUPABASE_SERVICE_ROLE_KEY を環境変数で渡してください（値はファイルに書かない）"); process.exit(2); }
  const { createClient } = await import("@supabase/supabase-js");
  const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const out = path.join(process.argv[2] || "./backup", "storage");
  await mkdir(out, { recursive: true });
  const all = [];
  for (const b of BUCKETS) {
    const m = await backupBucket(client, b, out);
    all.push(...m);
    console.log(`OK: ${b} ${m.length}件・${(m.reduce((a, x) => a + x.size, 0) / 1048576).toFixed(1)}MB`);
  }
  await writeFile(path.join(out, "manifest.json"), JSON.stringify({ at: new Date().toISOString(), files: all }, null, 1));
  console.log(`OK: 一覧 ${path.join(out, "manifest.json")}（${all.length}件）`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(e => { console.error("失敗：", String(e?.message || e).slice(0, 300)); process.exit(1); });
