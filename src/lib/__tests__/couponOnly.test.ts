import { describe, it, expect } from "vitest";
import { webBookableWith, catalogMenuTab, catalogCouponMenus, webSlots, errorText, type PublicCatalog, type PublicMenu, type PublicCoupon } from "@/lib/web";
import type { Coupon, Lane, Menu, Staff, Store } from "@/lib/db/types";

// 0018：メニューの「クーポン専用」。メニュー欄に出さない・単品でネット予約できない・対象にしたクーポンでだけ予約できる。店の画面では普通に使える
const pm = (id: string, extra: Partial<PublicMenu> = {}): PublicMenu => ({ id, name: id, price: 6600, duration_min: 50, target: "all", nominatable: true, people: 1, ...extra });
const pc = (id: string, menu_ids: string[]): PublicCoupon => ({ id, name: id, kind: "fixed", value: 5500, menu_ids, target: "all", has_code: false });

describe("webBookableWith", () => {
  it("普通のメニューはクーポン無しでも予約できる", () => {
    expect(webBookableWith({ id: "m1" })).toBe(true);
    expect(webBookableWith({ id: "m1", coupon_only: false }, null)).toBe(true);
  });
  it("クーポン専用は、そのメニューを対象にしたクーポンのときだけ", () => {
    const m = { id: "m100", coupon_only: true };
    expect(webBookableWith(m)).toBe(false);
    expect(webBookableWith(m, null)).toBe(false);
    expect(webBookableWith(m, { menu_ids: ["m100"] })).toBe(true);
    expect(webBookableWith(m, { menu_ids: ["perm"] })).toBe(false);
    // 「全メニュー対象」（menu_ids が空）のクーポンでは予約できない（SQL と同じ）
    expect(webBookableWith(m, { menu_ids: [] })).toBe(false);
  });
});

describe("予約ページのメニュー欄・クーポンの選択肢", () => {
  const cat: Pick<PublicCatalog, "menus" | "coupon_menus"> = {
    menus: [pm("brow"), pm("perm")],
    coupon_menus: [pm("m100", { coupon_only: true }), pm("set1", { coupon_only: true })],
  };
  it("メニュー欄にクーポン専用は出ない（古い形で menus に混ざっていても出さない）", () => {
    expect(catalogMenuTab(cat).map(m => m.id)).toEqual(["brow", "perm"]);
    expect(catalogMenuTab({ menus: [pm("brow"), pm("x", { coupon_only: true })] }).map(m => m.id)).toEqual(["brow"]);
  });
  it("対象を指定したクーポンはクーポン専用メニューを選べる", () => {
    expect(catalogCouponMenus(cat, pc("c13", ["m100"])).map(m => m.id)).toEqual(["m100"]);
    expect(catalogCouponMenus(cat, pc("c7", ["perm"])).map(m => m.id)).toEqual(["perm"]);
    expect(catalogCouponMenus(cat, pc("cx", ["perm", "set1"])).map(m => m.id)).toEqual(["perm", "set1"]);
  });
  it("全メニュー対象のクーポンはメニュー欄のものだけ", () => {
    expect(catalogCouponMenus(cat, pc("call", [])).map(m => m.id)).toEqual(["brow", "perm"]);
  });
  it("0018 未適用（coupon_menus が無い）でも今までどおり", () => {
    const old = { menus: [pm("brow"), pm("m100")] };
    expect(catalogMenuTab(old).map(m => m.id)).toEqual(["brow", "m100"]);
    expect(catalogCouponMenus(old, pc("c13", ["m100"])).map(m => m.id)).toEqual(["m100"]);
  });
  it("エラーの文", () => {
    expect(errorText(new Error("menu_coupon_only"), "ja")).toContain("クーポンからご予約ください");
    expect(errorText(new Error("menu_coupon_only"), "en")).toContain("coupon");
  });
});

describe("空き時間（webSlots）", () => {
  const store = { id: "s", company_id: "c", name: "箱崎", business_type: "eyelash", open_time: "10:00", close_time: "19:00", slot_minutes: 15,
    booking_horizon_days: 60, booking_lead_min: 60, start_step_min: 30, room_count: null, last_order_offset_min: null } as unknown as Store;
  const lanes: Lane[] = [{ id: "l1", store_id: "s", name: "1名様", capacity: 1, sort_order: 1, active: true } as Lane];
  const staff: Staff[] = [{ id: "st1", company_id: "c", name: "飯田", role: "staff", active: true, show_on_ledger: true } as Staff];
  const now = new Date("2026-11-10T08:00:00");
  const date = "2026-11-12";
  const shifts = [{ id: "sh1", store_id: "s", staff_id: "st1", date, kind: "work", start_time: "10:00", end_time: "19:00" }] as never[];
  const menu = { id: "m100", store_id: "s", name: "フラットマットラッシュ100本", category: "technical", price: 6600, tax_rate: 0.1, duration_min: 50, interval_min: 0, sort_order: 30, active: true,
    web_visible: true, people: 1, coupon_only: true } as Menu;
  const coupon = (menu_ids: string[]) => ({ id: "c13", store_id: "s", name: "【100本】", kind: "fixed", value: 6600, menu_ids, target: "all", active: true, web_visible: true }) as unknown as Coupon;
  const base = { store, menu, lanes, shifts, bookings: [], staff, date, now };
  it("クーポン専用：クーポン無し・対象外・全メニュー対象のクーポンでは空きが出ない", () => {
    expect(webSlots({ ...base })).toEqual([]);
    expect(webSlots({ ...base, coupon: coupon(["perm"]) })).toEqual([]);
    expect(webSlots({ ...base, coupon: coupon([]) })).toEqual([]);
  });
  it("クーポン専用：対象にしたクーポンなら空きが出る", () => {
    expect(webSlots({ ...base, coupon: coupon(["m100"]) }).length).toBeGreaterThan(0);
  });
  it("普通のメニュー（coupon_only=false）は単品で空きが出る", () => {
    expect(webSlots({ ...base, menu: { ...menu, coupon_only: false } }).length).toBeGreaterThan(0);
  });
  it("店の画面（電話予約）はクーポン専用でも普通に使える", () => {
    expect(webSlots({ ...base, staffMode: true }).length).toBeGreaterThan(0);
  });
});
