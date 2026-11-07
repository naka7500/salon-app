import { describe, it, expect } from "vitest";
import type { Menu } from "@/lib/db/types";
import { paletteMenus, resolvePaletteIds, snapStart, blockDropError, PALETTE_DEFAULT_MAX } from "@/lib/ledgerPalette";

const M = (id: string, o: Partial<Menu> = {}): Menu => ({ id, store_id: "s", name: id, category: "technical", price: 1000, tax_rate: 10, duration_min: 60, interval_min: 0, sort_order: 0, active: true, ...o });

describe("台帳に出すメニュー", () => {
  const menus = [M("a", { sort_order: 2 }), M("b", { sort_order: 1 }), M("opt", { category: "option" }), M("off", { active: false }), M("hidden", { web_visible: false, sort_order: 0 }),
    ...Array.from({ length: 10 }, (_, i) => M(`x${i}`, { sort_order: 10 + i }))];
  it("既定：ネット掲載の技術メニューを並び順で先頭8件（オプション・使わないは出さない）", () => {
    const r = paletteMenus(menus, null);
    expect(r.length).toBe(PALETTE_DEFAULT_MAX);
    expect(r.slice(0, 3).map(m => m.id)).toEqual(["b", "a", "x0"]);
    expect(r.some(m => m.id === "hidden" || m.id === "opt" || m.id === "off")).toBe(false);
  });
  it("選択があればその順番（ネット非掲載も選べる・消えたメニューは飛ばす）", () => {
    expect(paletteMenus(menus, ["hidden", "gone", "a"]).map(m => m.id)).toEqual(["hidden", "a"]);
    expect(paletteMenus(menus, [])).toEqual([]);
  });
  it("DBの設定 → 端末の保存 → 既定", () => {
    expect(resolvePaletteIds({ id: "s", ledger_menu_ids: ["a"] }, '["b"]')).toEqual(["a"]);
    expect(resolvePaletteIds({ id: "s", ledger_menu_ids: null }, '["b"]')).toEqual(["b"]);
    expect(resolvePaletteIds({ id: "s" }, "壊れた")).toBeNull();
  });
});

describe("落とした位置", () => {
  it("開始時刻の刻みにそろえる・範囲の外は端へ", () => {
    expect(snapStart(10 * 60 + 14, 30, 540, 1140)).toBe(600);
    expect(snapStart(10 * 60 + 16, 30, 540, 1140)).toBe(630);
    expect(snapStart(10 * 60 + 7, 15, 540, 1140)).toBe(600);
    expect(snapStart(100, 30, 540, 1140)).toBe(540);
    expect(snapStart(2000, 30, 540, 1140)).toBe(1110);
  });
  it("置ける行", () => {
    expect(blockDropError("idle", "lane", false)).toBeNull();
    expect(blockDropError("idle", "staff", false)).toContain("受付枠");
    expect(blockDropError("break", "staff", false)).toBeNull();
    expect(blockDropError("guarantee", "lane", false)).toContain("スタッフ");
    expect(blockDropError("close", "pair", false)).toContain("ペア");
    expect(blockDropError("close", "pair", true)).toBeNull();
  });
});
