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
    const d = await memoryRepo.addConsentDocument({ customer_id: cs[0].id, template_id: t.id, signer_name: cs[0].name }, pdf());
    expect(d).toMatchObject({ customer_id: cs[0].id, template_id: t.id, template_title: "施術同意書", signer_name: cs[0].name });
    expect(d.signed_by_staff_id).toBeTruthy();
    expect(d.file_path).toMatch(/^demo-img:/);
    const list = await memoryRepo.consentDocuments(cs[0].id);
    expect(list).toHaveLength(1);
    expect((await memoryRepo.consentFileUrls([d.file_path]))[d.file_path]).toMatch(/^data:application\/pdf/);
    const blob = await memoryRepo.consentFileBlob(d.file_path);
    expect(blob.type).toBe("application/pdf");
    // 署名日時・担当・テンプレ名は保存する側（サーバ相当）が決める。PDF の指紋（SHA-256）と大きさが残る
    expect(Math.abs(Date.now() - new Date(d.signed_at).getTime())).toBeLessThan(5000);
    expect(d.signed_by_name).toBeTruthy();
    expect(d.file_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(d.file_size).toBe(pdf().size);
    expect(d.voided_at).toBeNull();
    // 名前が空なら保存しない
    await expect(memoryRepo.addConsentDocument({ customer_id: cs[0].id, template_id: t.id, signer_name: "  " }, pdf())).rejects.toThrow(/お名前/);
    // 「使わない」にしたテンプレ・存在しないテンプレでは署名を保存できない（L3）
    await expect(memoryRepo.addConsentDocument({ customer_id: cs[0].id, template_id: img.id, signer_name: cs[0].name }, pdf())).rejects.toThrow(/使わない/);
    await expect(memoryRepo.addConsentDocument({ customer_id: cs[0].id, template_id: "no-such", signer_name: cs[0].name }, pdf())).rejects.toThrow(/使えません/);
    setDemoRole("owner");
  });

  it("取り消しはオーナーだけ・理由つき・1回きり。書類とPDFは残り、修正履歴に残る（M3）", async () => {
    const { memoryRepo, setDemoRole } = await import("@/lib/db/memory");
    setDemoRole("owner");
    const cs = await memoryRepo.customers("", { limit: 1 });
    const d = (await memoryRepo.consentDocuments(cs[0].id))![0];
    setDemoRole("staff");
    await expect(memoryRepo.voidConsentDocument(d.id, "間違えた")).rejects.toThrow(/オーナーだけ/);
    setDemoRole("manager");
    await expect(memoryRepo.voidConsentDocument(d.id, "間違えた")).rejects.toThrow(/オーナーだけ/);
    setDemoRole("owner");
    await expect(memoryRepo.voidConsentDocument(d.id, "  ")).rejects.toThrow(/理由/);
    const v = await memoryRepo.voidConsentDocument(d.id, "別のお客様で取ってしまった");
    expect(v).toMatchObject({ id: d.id, void_reason: "別のお客様で取ってしまった", signer_name: d.signer_name, file_path: d.file_path, file_sha256: d.file_sha256, signed_at: d.signed_at });
    expect(v.voided_at).toBeTruthy();
    await expect(memoryRepo.voidConsentDocument(d.id, "もう一度")).rejects.toThrow(/もう取り消されています/);
    const list = (await memoryRepo.consentDocuments(cs[0].id))!;
    expect(list).toHaveLength(1);                                   // 行は残る
    expect((await memoryRepo.consentFileBlob(d.file_path)).type).toBe("application/pdf");   // PDF も残る
    const logs = (await memoryRepo.auditLogs("2000-01-01", "2999-12-31")) ?? [];
    expect(logs.some(l => l.table_name === "consent_documents" && l.action === "sign" && l.row_id === d.id)).toBe(true);
    expect(logs.some(l => l.table_name === "consent_documents" && l.action === "void" && l.row_id === d.id && l.reason === "別のお客様で取ってしまった")).toBe(true);
  });

  it("お客様を統合すると、署名済みの同意書も残す側へ移る（M5）", async () => {
    const { memoryRepo, setDemoRole } = await import("@/lib/db/memory");
    setDemoRole("owner");
    const t = (await memoryRepo.consentTemplates())!.find(x => x.active)!;
    const cs = await memoryRepo.customers("", { limit: 5 });
    const keep = cs[0], gone = cs.find(c => c.id !== keep.id)!;
    const before = (await memoryRepo.consentDocuments(keep.id))!.length;
    const d = await memoryRepo.addConsentDocument({ customer_id: gone.id, template_id: t.id, signer_name: gone.name }, pdf());
    const r = await memoryRepo.mergeCustomers(keep.id, gone.id);
    expect(r.ok).toBe(true); expect(r.message).toMatch(/同意書 1件/);
    const after = (await memoryRepo.consentDocuments(keep.id))!;
    expect(after).toHaveLength(before + 1);
    expect(after.find(x => x.id === d.id)).toMatchObject({ customer_id: keep.id, file_path: d.file_path, file_sha256: d.file_sha256, signer_name: gone.name });
    expect(await memoryRepo.consentDocuments(gone.id)).toHaveLength(0);
    expect((await memoryRepo.consentFileBlob(d.file_path)).type).toBe("application/pdf");   // PDF の場所は変わらない
  });
});
