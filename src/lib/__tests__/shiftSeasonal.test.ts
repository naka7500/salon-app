import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { KIND_LABEL } from "@/lib/schedule";
import type { ShiftKind } from "@/lib/db/types";

// シフトの種類「夏季冬季休暇」（seasonal・0023）：休暇だが 休／有給／店休 とは別に数える
const store: Record<string, string> = {};
beforeAll(() => {
  (globalThis as unknown as { window: unknown }).window = globalThis;
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; },
    clear: () => { for (const k of Object.keys(store)) delete store[k]; }, key: i => Object.keys(store)[i] ?? null, get length() { return Object.keys(store).length; },
  } as Storage;
});
afterAll(() => { delete (globalThis as { window?: unknown }).window; delete (globalThis as { localStorage?: unknown }).localStorage; });

describe("シフトの種類：夏季冬季休暇", () => {
  it("ラベルがあり、有給とは別の種類", () => {
    expect(KIND_LABEL.seasonal).toBe("夏季冬季休暇");
    expect(KIND_LABEL.paid).toBe("有給");
    expect(Object.keys(KIND_LABEL) as ShiftKind[]).toEqual(["work", "off", "paid", "closed", "seasonal"]);
  });

  it("デモ：パターンは店休の次に出る・入れたシフトは出勤に数えない", async () => {
    const { memoryRepo, defaultPatterns } = await import("@/lib/db/memory");
    const st = await memoryRepo.store();
    const names = defaultPatterns(st).map(p => p.name);
    expect(names.indexOf("夏季冬季休暇")).toBe(names.indexOf("店休") + 1);

    const pats = await memoryRepo.shiftPatterns();
    const sp = pats.find(p => p.kind === "seasonal")!;
    expect(sp).toMatchObject({ name: "夏季冬季休暇", kind: "seasonal" });
    expect(pats.indexOf(sp)).toBe(pats.findIndex(p => p.kind === "closed") + 1);

    const [s] = await memoryRepo.staff();
    const date = "2031-08-14";
    await memoryRepo.saveShifts([{ staff_id: s.id, date, kind: "seasonal", pattern_id: sp.id, start_time: null, end_time: null, is_store_closed: false, break_missed: false }]);
    const rows = (await memoryRepo.shiftsBetween(date, "2031-08-15")).filter(x => x.staff_id === s.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("seasonal");
    expect(rows.filter(x => x.kind === "work")).toHaveLength(0);
    expect(rows.filter(x => x.kind === "paid")).toHaveLength(0);
  });

  it("デモ：古い端末データ（パターン6件）を開くと 夏季冬季休暇 が足される（0023 相当）", async () => {
    const { memoryRepo, STORE_GOTANDA } = await import("@/lib/db/memory");
    memoryRepo.switchStore(STORE_GOTANDA);
    await memoryRepo.shiftPatterns();                                  // 端末に保存させる
    const key = `salon-app-demo-v5-${STORE_GOTANDA}`;
    const data = JSON.parse(store[key]);
    data.shiftPatterns = data.shiftPatterns.filter((p: { kind: string }) => p.kind !== "seasonal");
    expect(data.shiftPatterns).toHaveLength(6);
    store[key] = JSON.stringify(data);
    const pats = await memoryRepo.shiftPatterns();                    // 読むたびに upgrade() が走る
    expect(pats.filter(p => p.kind === "seasonal")).toHaveLength(1);
    expect(pats[pats.length - 1]).toMatchObject({ name: "夏季冬季休暇", sort_order: 7 });
  });
});
