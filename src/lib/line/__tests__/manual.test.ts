import { describe, it, expect } from "vitest";
import {
  MANUAL_BATCH_MAX, MANUAL_PER_BOOKING_PER_HOUR, MANUAL_PER_STORE_PER_HOUR, MANUAL_TEXT_MAX,
  MANUAL_PER_CUSTOMER_PER_HOUR, directSendError, directTemplate, parseDirectBody,
  absenceTemplate, absenceTemplateRaw, canSendManual, fillManualText, lineStatusOf, manualSendError, manualTextError, parseManualItems, quotaLeft,
} from "../manual";

const S = "aaaaaaaa-0000-0000-0000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000001";
const link = { followed: true, opted_out: false, line_user_id: "U" + "0".repeat(32) };
const base = { booking: { store_id: S, status: "booked", customer_id: "c1" }, storeId: S, link, recentForBooking: 0, recentForStore: 0, used: 0, limit: 200 };

describe("LINEの状態", () => {
  it("つながっている／つながっていない／配信停止中", () => {
    expect(lineStatusOf(null)).toBe("none");
    expect(lineStatusOf(undefined)).toBe("none");
    expect(lineStatusOf({ followed: true, opted_out: false })).toBe("linked");
    expect(lineStatusOf({ followed: true, opted_out: true })).toBe("stopped");
    expect(lineStatusOf({ followed: false, opted_out: false })).toBe("stopped");   // ブロック
  });
});

describe("送ってよい人", () => {
  it("オーナー・店長・スタッフは可。閲覧のみ・退職・不明は不可", () => {
    expect(canSendManual("owner")).toBe(true);
    expect(canSendManual("manager")).toBe(true);
    expect(canSendManual("staff")).toBe(true);
    expect(canSendManual("viewer")).toBe(false);
    expect(canSendManual(null)).toBe(false);
    expect(canSendManual("staff", false)).toBe(false);
  });
});

describe("本文", () => {
  it("空・長すぎ・制御文字はだめ。改行はよい", () => {
    expect(manualTextError("")).toMatch(/空/);
    expect(manualTextError("   \n ")).toMatch(/空/);
    expect(manualTextError(123)).toMatch(/空/);
    expect(manualTextError("a".repeat(MANUAL_TEXT_MAX))).toBeNull();
    expect(manualTextError("a".repeat(MANUAL_TEXT_MAX + 1))).toMatch(/長すぎ/);
    expect(manualTextError("こんにちは\u0007")).toMatch(/使えない/);
    expect(manualTextError("1行目\n2行目\tタブ")).toBeNull();
  });
});

describe("画面から来た内容", () => {
  it("相手なし・多すぎ・予約IDの形がおかしい・本文エラー", () => {
    expect(parseManualItems({})).toEqual({ error: "送る相手がいません" });
    expect(parseManualItems({ items: [] })).toEqual({ error: "送る相手がいません" });
    expect(parseManualItems(null)).toEqual({ error: "送る相手がいません" });
    const many = Array.from({ length: MANUAL_BATCH_MAX + 1 }, () => ({ booking_id: B, text: "x" }));
    expect("error" in parseManualItems({ items: many })).toBe(true);
    expect(parseManualItems({ items: [{ booking_id: "abc", text: "x" }] })).toEqual({ error: "予約が分かりません" });
    expect(parseManualItems({ items: [{ booking_id: B, text: "" }] })).toEqual({ error: "本文が空です" });
  });
  it("前後の空白を取り、同じ予約は1回にする", () => {
    const r = parseManualItems({ items: [{ booking_id: B, text: "  こんにちは \n" }, { booking_id: B, text: "2回目" }] });
    expect(r).toEqual({ items: [{ booking_id: B, text: "こんにちは" }] });
  });
});

describe("送る前の確認（1人分）", () => {
  it("問題なければ null", () => { expect(manualSendError(base)).toBeNull(); });
  it("ほかの店舗・無い予約", () => {
    expect(manualSendError({ ...base, booking: null })).toMatch(/見つかりません/);
    expect(manualSendError({ ...base, booking: { ...base.booking, store_id: "other" } })).toMatch(/見つかりません/);
  });
  it("キャンセル済み・ブロック・お客様なし", () => {
    expect(manualSendError({ ...base, booking: { ...base.booking, status: "cancelled" } })).toMatch(/キャンセル/);
    expect(manualSendError({ ...base, booking: { ...base.booking, status: "block" } })).toMatch(/予約ではありません/);
    expect(manualSendError({ ...base, booking: { ...base.booking, customer_id: null } })).toMatch(/お客様が登録されていない/);
  });
  it("つながっていない・配信停止中・ブロック", () => {
    expect(manualSendError({ ...base, link: null })).toMatch(/つながっていません/);
    expect(manualSendError({ ...base, link: { ...link, opted_out: true } })).toMatch(/配信停止中/);
    expect(manualSendError({ ...base, link: { ...link, followed: false } })).toMatch(/配信停止中/);
  });
  it("同じ予約は1時間に3通まで・店舗全体の上限", () => {
    expect(manualSendError({ ...base, recentForBooking: MANUAL_PER_BOOKING_PER_HOUR - 1 })).toBeNull();
    expect(manualSendError({ ...base, recentForBooking: MANUAL_PER_BOOKING_PER_HOUR })).toMatch(/1時間に3通/);
    expect(manualSendError({ ...base, recentForStore: MANUAL_PER_STORE_PER_HOUR })).toMatch(/1時間に送れる数/);
  });
  it("今月の通数の上限", () => {
    expect(manualSendError({ ...base, used: 199 })).toBeNull();
    expect(manualSendError({ ...base, used: 200 })).toMatch(/上限/);
    expect(manualSendError({ ...base, limit: 0 })).toMatch(/上限/);
    expect(quotaLeft(150, 200)).toBe(50);
    expect(quotaLeft(250, 200)).toBe(0);
  });
});

describe("急なお休みの文面", () => {
  const at = "2026-11-10T05:30:00.000Z";   // 11/10（火）14:30 JST
  it("名前・日時・メニュー・店舗名・電話が入る", () => {
    const t = absenceTemplate({ storeName: "ラシエル箱崎", customerName: "山田 花子", startAt: at, menu: "まつげパーマ", phone: "092-000-0000" });
    expect(t.startsWith("山田 花子様\n")).toBe(true);
    expect(t).toContain("11月10日（火） 14:30〜「まつげパーマ」");
    expect(t).toContain("ラシエル箱崎です。");
    expect(t).toContain("ラシエル箱崎（092-000-0000）");
    expect(t).toContain("キャンセル料は一切かかりません");
    expect(manualTextError(t)).toBeNull();
  });
  it("メニューが無ければ「」を出さない・名前が無ければ「お客様」", () => {
    const t = fillManualText(absenceTemplateRaw("店", null), { customerName: "", startAt: at, menu: "" });
    expect(t).not.toContain("「」");
    expect(t.startsWith("お客様\n")).toBe(true);
    expect(t.trim().endsWith("店")).toBe(true);
  });
  it("差し込みは全部入れ替わる", () => {
    const t = fillManualText("{お名前}様 {日時} {メニュー} {お名前}", { customerName: "A", startAt: at, menu: "M" });
    expect(t).toBe("A様 11月10日（火） 14:30 M A");
  });
});

describe("顧客詳細からの送信（予約に結びつけない）", () => {
  const C = "cccccccc-0000-4000-8000-000000000001";
  const CO = "dddddddd-0000-0000-0000-000000000001";
  const d = { customer: { company_id: CO, merged_into: null }, companyId: CO, link, recentForCustomer: 0, recentForStore: 0, used: 0, limit: 200 };
  it("画面から来た内容：お客様IDの形・本文を確かめ、前後の空白を取る", () => {
    expect(parseDirectBody(null)).toEqual({ error: "お客様が分かりません" });
    expect(parseDirectBody({ customer_id: "c1", text: "x" })).toEqual({ error: "お客様が分かりません" });
    expect(parseDirectBody({ customer_id: C, text: " " })).toEqual({ error: "本文が空です" });
    expect(parseDirectBody({ customer_id: C, text: "a".repeat(MANUAL_TEXT_MAX + 1) })).toHaveProperty("error");
    expect(parseDirectBody({ customer_id: C, text: "x\u0000" })).toEqual({ error: "本文に使えない文字が入っています" });
    expect(parseDirectBody({ customer_id: C, text: "  こんにちは\n" })).toEqual({ customer_id: C, text: "こんにちは" });
  });
  it("送ってよい", () => { expect(directSendError(d)).toBeNull(); });
  it("ほかの会社のお客様・見つからない・統合済み", () => {
    expect(directSendError({ ...d, customer: null })).toMatch(/見つかりません/);
    expect(directSendError({ ...d, customer: { company_id: "other" } })).toMatch(/見つかりません/);
    expect(directSendError({ ...d, customer: { company_id: CO, merged_into: "x" } })).toMatch(/統合/);
  });
  it("つながっていない・配信停止中・ブロック", () => {
    expect(directSendError({ ...d, link: null })).toMatch(/つながっていません/);
    expect(directSendError({ ...d, link: { ...link, opted_out: true } })).toMatch(/配信停止/);
    expect(directSendError({ ...d, link: { ...link, followed: false } })).toMatch(/配信停止/);
  });
  it("同じお客様へ1時間3通・店舗の1時間の上限・今月の通数", () => {
    expect(directSendError({ ...d, recentForCustomer: MANUAL_PER_CUSTOMER_PER_HOUR - 1 })).toBeNull();
    expect(directSendError({ ...d, recentForCustomer: MANUAL_PER_CUSTOMER_PER_HOUR })).toMatch(/1時間に3通/);
    expect(directSendError({ ...d, recentForStore: MANUAL_PER_STORE_PER_HOUR })).toMatch(/1時間に送れる数/);
    expect(directSendError({ ...d, used: 200 })).toMatch(/上限/);
  });
  it("最初の文面：名前・店名・署名（電話）", () => {
    const t = directTemplate({ customerName: "山田 花子", storeName: "ラシエル箱崎", phone: "092-000-0000" });
    expect(t.startsWith("山田 花子様\nラシエル箱崎です。\n\n")).toBe(true);
    expect(t.endsWith("ラシエル箱崎（092-000-0000）")).toBe(true);
    expect(directTemplate({ customerName: "", storeName: "店" })).toBe("お客様\n店です。\n\n\n\n店");
  });
});
