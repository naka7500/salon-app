import { describe, it, expect } from "vitest";
import type { Booking, Menu } from "@/lib/db/types";
import { pairLines, pairModeChoices, saleTax, saleTotals, validateSale } from "@/lib/pos";
import { slipBreakdown } from "@/lib/accounting";

const M = (id: string, price: number, o: Partial<Menu> = {}): Menu => ({ id, store_id: "s", name: id, category: "technical", price, tax_rate: 0.1, duration_min: 90, interval_min: 0, sort_order: 0, active: true, ...o });
const B = (id: string, o: Partial<Booking> = {}): Booking => ({ id, store_id: "s", start_at: "2026-11-07T06:00:00Z", end_at: "2026-11-07T07:30:00Z", status: "arrived", channel: "phone", menu_ids: [], nominated: false, created_at: "", updated_at: "", ...o });
const staff = [{ id: "s1", name: "菊池" }, { id: "s2", name: "富塚" }];
const sum = (ls: { unit_price: number; qty: number }[]) => ls.reduce((a, l) => a + l.unit_price * l.qty, 0);

describe("C1 ペアを2枚に分ける：2人目に1組分の料金を入れない", () => {
  const pair = M("pair90", 26400, { people: 2 });
  const b1 = B("b1", { customer_id: "c1", staff_id: "s1", pair_group: "g", menu_ids: ["pair90"] });
  const b2 = B("b2", { customer_id: null, customer_name: "同行者", staff_id: "s2", pair_group: "g", menu_ids: ["pair90"] });
  it("1人目（分ける）＝半分", () => expect(sum(pairLines(b1, [b1, b2], "split", [pair], staff))).toBe(13200));
  it("1人目が会計済みでも、2人目は残りの半分（以前は26,400円になっていた）", () => {
    const paid = { ...b1, status: "done" as const };
    const ls = pairLines(b2, [paid, b2], "one", [pair], staff);
    expect(sum(ls)).toBe(13200);
    expect(pairModeChoices(b2, [paid, b2])).toMatchObject({ isPair: true, othersPaid: 1 });
  });
  it("2枚の合計＝1組の料金（奇数でも1円もずれない）", () => {
    const odd = M("pair90", 26401, { people: 2 });
    expect(sum(pairLines(b1, [b1, b2], "split", [odd], staff)) + sum(pairLines(b2, [{ ...b1, status: "done" }, b2], "split", [odd], staff))).toBe(26401);
  });
  it("1枚にまとめる＝1組の料金", () => expect(sum(pairLines(b1, [b1, b2], "one", [pair], staff))).toBe(26400));
});

describe("H1 1名用メニューのペアを1枚にまとめる：人数分を請求する", () => {
  const one = M("sub90", 13200, { people: 1 });
  const b1 = B("b1", { customer_id: "c1", staff_id: "s1", pair_group: "g", menu_ids: ["sub90"] });
  const b2 = B("b2", { staff_id: "s2", pair_group: "g", menu_ids: ["sub90"] });
  it("1枚＝2人分（以前は13,200円だけ）", () => {
    const ls = pairLines(b1, [b1, b2], "one", [one], staff);
    expect(ls.length).toBe(2); expect(sum(ls)).toBe(26400);
    expect(ls.map(l => l.staff_id)).toEqual(["s1", "s2"]);
  });
  it("分ける＝この方の分だけ", () => expect(sum(pairLines(b2, [b1, b2], "split", [one], staff))).toBe(13200));
  it("ペアでない予約はそのまま", () => expect(sum(pairLines(B("x", { menu_ids: ["sub90"] }), [], "one", [one], staff))).toBe(13200));
});

describe("H5 会計の入力チェック", () => {
  const line = { kind: "menu" as const, menu_id: "m", product_id: null, name: "90分", unit_price: 13200, qty: 1, tax_rate: 0.1, staff_id: "s1" };
  it("数量マイナスは不可", () => expect(validateSale({ lines: [{ ...line, qty: -2 }], discount: 0, payments: [{ method: "cash", amount: 0 }] })).toContain("数量"));
  it("値引はマイナス・小計超えは不可", () => {
    expect(validateSale({ lines: [line], discount: -100, payments: [{ method: "cash", amount: 13300 }] })).toContain("値引");
    expect(validateSale({ lines: [line], discount: 20000, payments: [] })).toContain("小計");
  });
  it("カードで合計より多くは受け取れない（お釣りは現金だけ）", () => {
    expect(validateSale({ lines: [line], discount: 0, payments: [{ method: "card", amount: 50000 }] })).toContain("現金以外");
    expect(validateSale({ lines: [line], discount: 0, payments: [{ method: "card", amount: 10000 }, { method: "cash", amount: 5000 }] })).toBeNull();
    expect(validateSale({ lines: [line], discount: 0, payments: [{ method: "cash", amount: 20000 }] })).toBeNull();
  });
  it("お預かり不足", () => expect(validateSale({ lines: [line], discount: 0, payments: [{ method: "cash", amount: 100 }] })).toContain("足りません"));
});

describe("M7 消費税は1通り（経理日別売上集計と同じ）", () => {
  it("1〜50,000円で slipBreakdown と一致（値引・店販8%込み）", () => {
    for (let g = 1; g <= 50000; g += 7) {
      const lines = [{ kind: "menu" as const, unit_price: g, qty: 1, tax_rate: 0.1 }, { kind: "product" as const, unit_price: (g % 900) + 100, qty: 1, tax_rate: 0.08 }];
      const disc = g % 300;
      const t = saleTotals(lines, disc);
      const s = { lines: lines.map(l => ({ ...l, amount: l.unit_price * l.qty })), discount: disc, payments: [], total: t.total } as unknown as Parameters<typeof slipBreakdown>[0];
      const b = slipBreakdown(s);
      expect(saleTax(lines, disc)).toBe(b.tech.tax + b.product.tax);
    }
  });
});
