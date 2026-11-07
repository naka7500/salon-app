import { describe, it, expect, beforeAll, afterAll } from "vitest";

// デモ（メモリ）でも「ユーザーを追加」「パスワードを変更」が動く。パスワードはどこにも保存しない
const store: Record<string, string> = {};
beforeAll(() => {
  (globalThis as unknown as { window: unknown }).window = globalThis;   // デモは「ブラウザの中」でだけ保存する
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; },
    clear: () => { for (const k of Object.keys(store)) delete store[k]; }, key: i => Object.keys(store)[i] ?? null, get length() { return Object.keys(store).length; },
  } as Storage;
});

afterAll(() => { delete (globalThis as { window?: unknown }).window; delete (globalThis as { localStorage?: unknown }).localStorage; });

describe("デモ：設定＞ユーザー", () => {
  it("オーナーは作れる・パスワードは保存されない・変更もできる", async () => {
    const { memoryRepo, setDemoRole } = await import("@/lib/db/memory");
    setDemoRole("owner");
    const PW = "Hinoki-Mori-58";
    const r = await memoryRepo.staffLoginAction({ kind: "create_user", name: "テスト花子", role: "staff", email: "hana.test@example.com", password: PW, must_change: false, show_on_ledger: false });
    expect(r).toMatchObject({ ok: true, demo: true, status: "invited" });
    const all = await memoryRepo.allStaff();
    const s = all.find(x => x.id === r.staff_id)!;
    expect(s).toMatchObject({ name: "テスト花子", role: "staff", show_on_ledger: false, email: "hana.test@example.com" });
    const st = await memoryRepo.staffLoginStatus();
    expect(st.items.find(x => x.staff_id === s.id)).toMatchObject({ status: "invited", must_change: false });
    const r2 = await memoryRepo.staffLoginAction({ kind: "set_password", staff_id: s.id, password: "Kusunoki-Wind-31", must_change: true });
    expect(r2.ok).toBe(true);
    expect(JSON.stringify(store)).not.toContain(PW);
    expect(JSON.stringify(store)).not.toContain("Kusunoki-Wind-31");
    await expect(memoryRepo.staffLoginAction({ kind: "create_user", name: "x", role: "owner" as never, email: "x2@example.com", password: PW, must_change: true })).rejects.toThrow(/オーナーは作れません/);
    await expect(memoryRepo.staffLoginAction({ kind: "create_user", name: "x", role: "staff", email: "x3@example.com", password: "password12", must_change: true })).rejects.toThrow();
  });
  it("店長・スタッフは作れない", async () => {
    const { memoryRepo, setDemoRole } = await import("@/lib/db/memory");
    setDemoRole("manager");
    await expect(memoryRepo.staffLoginAction({ kind: "create_user", name: "x", role: "staff", email: "m@example.com", password: "Hinoki-Mori-58", must_change: true })).rejects.toThrow(/オーナーだけ/);
    setDemoRole("owner");
  });
});
