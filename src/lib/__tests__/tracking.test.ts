import { beforeAll, describe, expect, it } from "vitest";
import type { Booking, BookingHistoryEntry, Lane, Menu, Staff } from "@/lib/db/types";
import { trackingRows, routeLabel, worthRecording, opOf, pickHistory } from "../tracking";
import { ensureJst } from "../inbound/tz";

beforeAll(() => ensureJst());
const menus = [{ id: "m1", name: "90分サブリミックヘッドスパ", category: "technical", price: 13200 }, { id: "o1", name: "スキンケア", category: "option", price: 3300 }] as Menu[];
const staff = [{ id: "s1", name: "菊池" }, { id: "s2", name: "富塚" }] as Staff[];
const lanes = [{ id: "l1", name: "1名様でのご予約" }] as Lane[];
const ctx = { menus, staff, lanes };
const base: Partial<Booking> = { id: "b1", store_id: "st", staff_id: "s1", lane_id: "l1", start_at: "2026-11-07T01:00:00.000Z", end_at: "2026-11-07T02:30:00.000Z", status: "booked", channel: "own", menu_ids: ["m1"], nominated: false, booking_no: "W1", created_at: "2026-10-03T07:07:41.000Z" };
const e = (id: number, at: string, op: BookingHistoryEntry["op"], source: BookingHistoryEntry["source"], snap: Partial<Booking>, before: Partial<Booking> | null = null, actor: string | null = null): BookingHistoryEntry => ({ id, booking_id: "b1", at, op, source, actor_name: actor, snapshot: snap, before });

describe("予約トラッキングの表", () => {
  it("登録（ネット予約）→ 変更（予約台帳）：変わった項目だけ赤", () => {
    const moved = { ...base, staff_id: "s2", start_at: "2026-11-07T02:00:00.000Z", end_at: "2026-11-07T03:30:00.000Z" };
    const rows = trackingRows([e(1, "2026-10-03T07:07:41.000Z", "insert", "web", base), e(2, "2026-10-10T06:32:58.000Z", "update", "ledger", moved, base, "菊池")], moved, ctx);
    expect(rows.map(r => r.state)).toEqual(["登録", "変更"]);
    expect(rows[0].route).toBe("ネット予約");
    expect(rows[0].at).toBe("2026/10/03 16:07:41");
    expect(rows[0].staff).toBe("1名様でのご予約／菊池（フリー）");
    expect(rows[0].menu).toBe("90分サブリミックヘッドスパ");
    expect(rows[0].start).toBe("2026/11/07 10:00");
    expect(rows[1].route).toBe("予約台帳（菊池）");
    expect(rows[1].changed).toEqual(["staff", "start", "end"]);
  });
  it("メニュー・指名の変更、キャンセル、会計", () => {
    const m2 = { ...base, menu_ids: ["m1", "o1"], nominated: true };
    const c = { ...m2, status: "cancelled" as const };
    const rows = trackingRows([e(1, "2026-10-01T00:00:00Z", "insert", "ledger", { ...base, channel: "phone" }, null, "富塚"), e(2, "2026-10-02T00:00:00Z", "update", "ledger", m2, null, "富塚"), e(3, "2026-10-03T00:00:00Z", "cancel", "web", c, m2)], c, ctx);
    expect(rows[0].route).toBe("電話（予約台帳・富塚）");
    expect(rows[1].changed).toEqual(["menu", "staff"]);
    expect(rows[1].menu).toBe("90分サブリミックヘッドスパ＋スキンケア");
    expect(rows[2].state).toBe("キャンセル");
    expect(rows[2].route).toBe("ネット予約（お客様がキャンセル）");
    expect(rows[2].changed).toEqual(["status"]);
    const done = trackingRows([e(4, "2026-11-07T03:00:00Z", "update", "ledger", { ...base, status: "done" }, base, "菊池")], base, ctx);
    expect(done[1].state).toBe("会計");
  });
  it("0013 より前の予約：登録を推定して先頭に出す", () => {
    const rows = trackingRows([], { ...base, channel: "hpb", booking_no: null }, ctx);
    expect(rows).toHaveLength(1);
    expect(rows[0].estimated).toBe(true);
    expect(rows[0].route).toBe("HPB取り込み（記録開始前・推定）");
    const rows2 = trackingRows([e(9, "2026-11-01T00:00:00Z", "update", "system", { ...base, staff_id: "s2" }, base)], base, ctx);
    expect(rows2[0].estimated).toBe(true); expect(rows2[0].staff).toContain("菊池");
    expect(rows2[1].changed).toEqual(["staff"]);
    expect(rows2[1].route).toBe("自動処理");
  });
  it("経路の表示", () => {
    expect(routeLabel({ source: "hpb", op: "insert", actor_name: null })).toBe("HPB取り込み");
    expect(routeLabel({ source: "ledger", op: "insert", actor_name: "菊池" }, "klook")).toBe("OTA・Klook（予約台帳・菊池）");
    expect(routeLabel({ source: "ledger", op: "insert", actor_name: "菊池" }, "line")).toBe("LINE（予約台帳・菊池）");
    expect(routeLabel({ source: "ledger", op: "update", actor_name: null }, "phone")).toBe("予約台帳（スタッフ）");
  });
  it("記録する／しない（ブロック・何も変わらない更新は残さない）", () => {
    expect(worthRecording(null, { status: "block" })).toBe(false);
    expect(worthRecording({ status: "block" }, null)).toBe(false);
    expect(worthRecording(null, base)).toBe(true);
    expect(worthRecording(base, { ...base, updated_at: "x" } as Partial<Booking>)).toBe(false);
    expect(worthRecording(base, { ...base, staff_id: "s2" })).toBe(true);
    expect(opOf(null, base)).toBe("insert"); expect(opOf(base, null)).toBe("delete");
    expect(opOf(base, { ...base, status: "cancelled" })).toBe("cancel");
    expect(Object.keys(pickHistory({ ...base, note: "x", intake: [] }))).not.toContain("note");
  });
});
