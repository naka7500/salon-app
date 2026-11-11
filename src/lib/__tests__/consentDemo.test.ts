import { describe, it, expect, beforeAll, afterAll } from "vitest";

// デモ（メモリ）の同意書・問診票（0025 相当）：テンプレはオーナー・店長だけ、署名はスタッフでも保存できる、記録がお客様に紐づく
const store: Record<string, string> = {};
class FR {
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

const pdf = () => new Blob([new TextEncoder().encode("%PDF-1.4 test")], { type: "application/pdf" });

describe("デモ：同意書・問診票", () => {
  it("テンプレの追加はオーナー・店長だけ。スタッフは署名を保存でき、お客様の記録に残る", async () => {
    const { memoryRepo, setDemoRole } = await import("@/lib/db/memory");
    setDemoRole("staff");
    await expect(memoryRepo.saveConsentTemplate({ title: "施術同意書" }, pdf())).rejects.toThrow(/オーナー・店長/);
    setDemoRole("owner");
    await expect(memoryRepo.saveConsentTemplate({ title: "施術同意書" })).rejects.toThrow(/選んでください/);
    const t = await memoryRepo.saveConsentTemplate({ title: " 施術同意書 ", store_id: null }, pdf());
    expect(t).toMatchObject({ title: "施術同意書", kind: "pdf", mime: "application/pdf", active: true, store_id: null });
    expect(t.file_path).toMatch(/^demo-img:/);
    const img = await memoryRepo.saveConsentTemplate({ title: "問診票" }, new Blob([new Uint8Array([255, 216, 255])], { type: "image/jpeg" }));
    expect(img.kind).toBe("image");
    expect((await memoryRepo.consentTemplates())!.map(x => x.title)).toEqual(["施術同意書", "問診票"]);
    // 使わない → 一覧には残る（設定画面は all で見る）
    await memoryRepo.saveConsentTemplate({ ...img, active: false });
    expect((await memoryRepo.consentTemplates(true))!.find(x => x.id === img.id)?.active).toBe(false);

    setDemoRole("staff");
    const cs = await memoryRepo.customers("", { limit: 1 });
    const d = await memoryRepo.addConsentDocument({ customer_id: cs[0].id, template_id: t.id, template_title: t.title, signer_name: cs[0].name, signed_at: "2026-11-11T10:00:00.000Z" }, pdf());
    expect(d).toMatchObject({ customer_id: cs[0].id, template_id: t.id, template_title: "施術同意書", signer_name: cs[0].name });
    expect(d.signed_by_staff_id).toBeTruthy();
    expect(d.file_path).toMatch(/^demo-img:/);
    const list = await memoryRepo.consentDocuments(cs[0].id);
    expect(list).toHaveLength(1);
    expect((await memoryRepo.consentFileUrls([d.file_path]))[d.file_path]).toMatch(/^data:application\/pdf/);
    const blob = await memoryRepo.consentFileBlob(d.file_path);
    expect(blob.type).toBe("application/pdf");
    // 名前が空なら保存しない
    await expect(memoryRepo.addConsentDocument({ customer_id: cs[0].id, template_id: t.id, template_title: t.title, signer_name: "  ", signed_at: "2026-11-11T10:00:00.000Z" }, pdf())).rejects.toThrow(/お名前/);
    setDemoRole("owner");
  });
});
