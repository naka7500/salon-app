import { describe, it, expect, beforeAll, afterAll } from "vitest";

// デモ（メモリ）でも、手書きページに置いた画像（0024 相当）がページと一緒に保存され、消した画像の置き場所が片づく
const store: Record<string, string> = {};
class FR {   // Node には FileReader が無いので、readAsDataURL だけの代わり
  result: string | null = null; onload: null | (() => void) = null; onerror: null | (() => void) = null; error = null;
  readAsDataURL(b: Blob) { b.arrayBuffer().then(buf => { this.result = `data:${b.type || "application/octet-stream"};base64,${Buffer.from(buf).toString("base64")}`; this.onload?.(); }); }
}
beforeAll(() => {
  (globalThis as unknown as { window: unknown }).window = globalThis;
  (globalThis as unknown as { FileReader: unknown }).FileReader = FR;
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; },
    clear: () => { for (const k of Object.keys(store)) delete store[k]; }, key: i => Object.keys(store)[i] ?? null, get length() { return Object.keys(store).length; },
  } as Storage;
});
afterAll(() => { delete (globalThis as { window?: unknown }).window; delete (globalThis as { localStorage?: unknown }).localStorage; delete (globalThis as { FileReader?: unknown }).FileReader; });

const png = () => new Blob([new Uint8Array([137, 80, 78, 71, 1, 2, 3])], { type: "image/png" });
const jpg = () => new Blob([new Uint8Array([255, 216, 255, 9, 9])], { type: "image/jpeg" });
const ink = { v: 1 as const, w: 1414, h: 1000, items: [] };

describe("デモ：手書きページの画像レイヤー", () => {
  it("置いた画像はページと一緒に保存され、消すと置き場所も片づく", async () => {
    const { memoryRepo } = await import("@/lib/db/memory");
    const cs = await memoryRepo.customers("", { limit: 1 });
    const e = await memoryRepo.addKarte({ customer_id: cs[0].id, store_id: "", staff_id: null, visited_on: "2026-11-11", template: "eyelash", record: {}, handwriting: [] });
    const page = { id: "p1", strokes: ink, bg: { kind: "builtin" as const, key: "blank" }, opacity: 1, image: png(),
      images: [{ id: "i1", blob: jpg(), x: 100, y: 80, w: 600, h: 400 }, { id: "i2", blob: jpg(), x: 10, y: 10, w: 200, h: 100 }] };
    const rows = await memoryRepo.saveKartePages(e.id, [page]);
    expect(rows[0].background_builtin).toBe("blank");
    expect(rows[0].images).toHaveLength(2);
    expect(rows[0].images![0]).toMatchObject({ id: "i1", x: 100, y: 80, w: 600, h: 400 });
    expect(rows[0].images![0].path).toMatch(/^demo-img:/);
    const urls = await memoryRepo.karteFileUrls(rows[0].images!.map(i => i.path));
    expect(Object.keys(urls)).toHaveLength(2);
    // 1枚消して保存し直す → 消した画像の置き場所が無くなり、残した画像は同じ場所のまま
    const keep = rows[0].images![0];
    const rows2 = await memoryRepo.saveKartePages(e.id, [{ ...page, image: png(), images: [{ id: keep.id, path: keep.path, x: 120, y: 90, w: 600, h: 400 }] }]);
    expect(rows2[0].images).toHaveLength(1);
    expect(rows2[0].images![0]).toMatchObject({ id: "i1", path: keep.path, x: 120 });
    const gone = rows[0].images![1].path;
    expect(await memoryRepo.karteFileUrls([gone])).toEqual({});
    expect((await memoryRepo.karteFileUrls([keep.path]))[keep.path]).toBeTruthy();
    // 開き直したときも画像が付いてくる
    const again = await memoryRepo.kartePages([e.id]);
    expect(again![0].images).toHaveLength(1);
  });
  it("白紙は標準の背景として選べる", async () => {
    const { builtinByKey, builtinOrder } = await import("@/lib/karteTemplates");
    expect(builtinByKey("blank")?.name).toBe("白紙");
    expect(builtinOrder("eyelash")).toContain("blank");
    expect(builtinOrder("headspa")[0]).toBe("headspa");   // 最初に出る背景は今までどおり
  });
});
