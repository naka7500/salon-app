// バックアップのスクリプト（scripts/backup/backup-storage.mjs）：バケットの中を全部たどって書き出す・大きさと指紋を確かめる。
// 偽の Storage で確かめる（本番にはつながない）。
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { BUCKETS, backupBucket, listAll, safeJoin } from "../../../scripts/backup/backup-storage.mjs";

type Entry = { name: string; id: string | null; metadata?: { size: number } };
function fakeClient(files: Record<string, string>, opt: { failDownload?: string; wrongSize?: string } = {}) {
  const calls: string[] = [];
  const list = (prefix: string, o: { limit: number; offset: number }) => {
    const seen = new Map<string, Entry>();
    for (const p of Object.keys(files).sort()) {
      if (prefix && !p.startsWith(prefix + "/")) continue;
      const rest = prefix ? p.slice(prefix.length + 1) : p; const [head, ...tail] = rest.split("/");
      if (!seen.has(head)) seen.set(head, tail.length ? { name: head, id: null } : { name: head, id: "id-" + p, metadata: { size: Buffer.byteLength(files[p]) + (opt.wrongSize === p ? 1 : 0) } });
    }
    return { data: [...seen.values()].slice(o.offset, o.offset + o.limit), error: null };
  };
  return { calls, storage: { from: (bucket: string) => ({
    list: async (prefix: string, o: { limit: number; offset: number }) => { calls.push(`list ${bucket}/${prefix}@${o.offset}`); return list(prefix, o); },
    download: async (p: string) => opt.failDownload === p ? { data: null, error: { message: "not found" } } : { data: new Blob([files[p]]), error: null },
  }) } };
}
const FILES = { "co1/consents/a.pdf": "PDF-A", "co1/consents/b.pdf": "PDF-BB", "co1/consent-templates/t.png": "PNG", "top.txt": "x" };

describe("バックアップ：Storage の書き出し", () => {
  it("対象はカルテ画像（karte）と署名済み同意書（consents）の2つ", () => expect(BUCKETS).toEqual(["karte", "consents"]));
  it("フォルダの中まで全部たどる", async () => {
    const c = fakeClient(FILES);
    expect((await listAll(c, "consents")).map((f: { path: string }) => f.path).sort()).toEqual(Object.keys(FILES).sort());
  });
  it("1000件を超えるフォルダも、続きを取りにいく", async () => {
    const many: Record<string, string> = {}; for (let i = 0; i < 1500; i++) many[`co/${String(i).padStart(4, "0")}.png`] = "x";
    const c = fakeClient(many);
    expect(await listAll(c, "karte")).toHaveLength(1500);
    expect(c.calls).toContain("list karte/co@1000");
  });
  it("書き出したファイルの一覧（パス・大きさ・SHA-256）を返す。中身は元と同じ", async () => {
    const written: Record<string, Buffer> = {};
    const io = { mkdir: async () => undefined, writeFile: async (p: string, b: Buffer) => { written[p] = b; } };
    const m = (await backupBucket(fakeClient(FILES), "consents", "/out", io as never)) as { bucket: string; path: string; size: number; sha256: string }[];
    expect(m).toHaveLength(4);
    const a = m.find((x: { path: string }) => x.path === "co1/consents/a.pdf");
    expect(a).toEqual({ bucket: "consents", path: "co1/consents/a.pdf", size: 5, sha256: createHash("sha256").update("PDF-A").digest("hex") });
    expect(written["/out/consents/co1/consents/a.pdf"].toString()).toBe("PDF-A");
  });
  it("1つでも取れなければ「成功」にしない（途中で止まる）", async () => {
    const io = { mkdir: async () => undefined, writeFile: async () => undefined };
    await expect(backupBucket(fakeClient(FILES, { failDownload: "co1/consents/b.pdf" }), "consents", "/out", io as never)).rejects.toThrow("ダウンロードに失敗");
    await expect(backupBucket(fakeClient(FILES, { wrongSize: "co1/consents/a.pdf" }), "consents", "/out", io as never)).rejects.toThrow("大きさが合いません");
  });
  it("出力フォルダの外には書かない", () => {
    expect(safeJoin("/out/karte", "co/a.png")).toBe("/out/karte/co/a.png");
    expect(() => safeJoin("/out/karte", "../../etc/passwd")).toThrow();
    expect(() => safeJoin("/out/karte", "/etc/passwd")).toThrow();
  });
});
