import { describe, expect, it } from "vitest";
import type { Lane, Sale, SaleLine, Staff } from "@/lib/db/types";
import { defaultMain, parseMain, mainLabel, lastProductStaff, missingLineStaff, defaultLineStaff, lineStaffOptions, FREE_LABEL } from "../saleStaff";
import { staffShare, saleStaffIds } from "../reports";

const lanes = [{ id: "l1", store_id: "st", name: "1名様でのご予約", capacity: 1, sort_order: 1, active: true }, { id: "l2", store_id: "st", name: "2名様でのご予約（ペア予約）", capacity: 2, sort_order: 2, active: true }] as Lane[];
const staff = [{ id: "s1", name: "菊池", active: true, role: "manager", store_ids: ["st"] }, { id: "s2", name: "富塚", active: true, role: "staff", store_ids: ["st"] }, { id: "h1", name: "鮎川", active: true, role: "staff", store_ids: ["other"], home_store_id: "other" }, { id: "g1", name: "退職者", active: false, role: "staff", store_ids: ["st"] }] as Staff[];
let n = 0;
const line = (kind: SaleLine["kind"], amount: number, staff_id: string | null): SaleLine => ({ id: `l${++n}`, sale_id: "x", kind, name: kind, unit_price: amount, qty: 1, tax_rate: 0.1, staff_id, amount });
const sale = (lines: SaleLine[], o: Partial<Sale> = {}): Sale => ({ id: `s${++n}`, store_id: "st", sale_no: "1", sold_at: "2026-11-07T05:00:00Z", status: "confirmed", subtotal: 0, discount: 0, tax: 0, total: lines.reduce((a, l) => a + l.amount, 0), lines, payments: [], ...o });

describe("主担当（スタッフ／受付枠／フリー）", () => {
  it("予約からの初期値", () => {
    expect(defaultMain({ staff_id: "s1", lane_id: "l1", nominated: false, pair_group: null }, lanes, true)).toBe("lane:l1");
    expect(defaultMain({ staff_id: "s1", lane_id: "l1", nominated: true, pair_group: null }, lanes, true)).toBe("staff:s1");
    expect(defaultMain({ staff_id: "s1", lane_id: "l1", nominated: false, pair_group: "g" }, lanes, true)).toBe("lane:l2");
    expect(defaultMain({ staff_id: "s1", lane_id: null, nominated: false, pair_group: null }, lanes, true)).toBe("staff:s1");
    expect(defaultMain({ staff_id: "s1", lane_id: "l1", nominated: false, pair_group: null }, lanes, false)).toBe("staff:s1");   // 0013 前
    expect(defaultMain(null, lanes, true, "s2")).toBe("staff:s2");
  });
  it("保存する形と表示", () => {
    expect(parseMain("lane:l1", lanes)).toEqual({ main_staff_id: null, main_label: "1名様でのご予約", main_lane_id: "l1" });
    expect(parseMain("free", lanes)).toEqual({ main_staff_id: null, main_label: FREE_LABEL, main_lane_id: null });
    expect(parseMain("staff:s2", lanes)).toEqual({ main_staff_id: "s2", main_label: null, main_lane_id: null });
    expect(mainLabel({ main_staff_id: null, main_label: "1名様でのご予約" }, staff)).toBe("1名様でのご予約");
    expect(mainLabel({ main_staff_id: "s2", main_label: null }, staff)).toBe("富塚");
  });
});

describe("明細担当で売上を数える", () => {
  it("主担当が受付枠でも、売上は明細担当（技術＝富塚、店販＝ヘルプの鮎川）", () => {
    const s = sale([line("menu", 13200, "s2"), line("product", 4400, "h1")], { main_staff_id: null, main_label: "1名様でのご予約" });
    expect(saleStaffIds(s).sort()).toEqual(["h1", "s2"]);
    expect(staffShare(s, "s2")).toBeCloseTo(13200 / 17600);
    expect(staffShare(s, "h1")).toBeCloseTo(4400 / 17600);
    expect(staffShare(s, "s1")).toBe(0);
  });
  it("主担当がスタッフでも、明細担当が別の人ならその人に入る（主担当には入らない）", () => {
    const s = sale([line("menu", 10000, "s2"), line("product", 2000, "s2")], { main_staff_id: "s1" });
    expect(saleStaffIds(s)).toEqual(["s2"]);
    expect(staffShare(s, "s1")).toBe(0);
    expect(staffShare(s, "s2")).toBe(1);
  });
  it("明細担当が空の古い行だけ主担当", () => {
    const s = sale([line("menu", 10000, null), line("product", 2000, "s2")], { main_staff_id: "s1" });
    expect(saleStaffIds(s).sort()).toEqual(["s1", "s2"]);
    expect(staffShare(s, "s1")).toBeCloseTo(10000 / 12000);
  });
  it("行の初期値：技術＝施術担当、店販＝空（選ぶまで確定できない）", () => {
    expect(defaultLineStaff("menu", "s1")).toBe("s1");
    expect(defaultLineStaff("option", "s1")).toBe("s1");
    expect(defaultLineStaff("product", "s1")).toBeNull();
    expect(missingLineStaff([{ staff_id: "s1" }, { staff_id: null }, { staff_id: undefined }])).toEqual([1, 2]);
  });
  it("前回の店販の担当（候補）", () => {
    const old = sale([line("menu", 1, "s1"), line("product", 1, "h1")], { customer_id: "c1", sold_at: "2026-09-01T00:00:00Z" });
    const newer = sale([line("menu", 1, "s2")], { customer_id: "c1", sold_at: "2026-10-01T00:00:00Z" });
    const voided = sale([line("product", 1, "s2")], { customer_id: "c1", sold_at: "2026-10-02T00:00:00Z", status: "voided" });
    expect(lastProductStaff([old, newer, voided], "c1")).toBe("h1");
    expect(lastProductStaff([newer], "c1")).toBeNull();
  });
  it("選択肢：この店舗／ほかの店舗（ヘルプ）／退職は今の値のときだけ", () => {
    const o = lineStaffOptions(staff, "st", "g1");
    expect(o.here.map(s => s.id)).toEqual(["s1", "s2"]);
    expect(o.other.map(s => s.id)).toEqual(["h1"]);
    expect(o.gone.map(s => s.id)).toEqual(["g1"]);
  });
});
