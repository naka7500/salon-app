// 監査 2026-11-07 R1：LINE予約からの自動連携で、電話番号だけで他人のお客様情報・LINE連携を取れないこと
import { describe, it, expect } from "vitest";
import { bookingLinkDecision, mergeLinkedVia, prefillAllowed } from "@/lib/line/linkPolicy";
import { memoryLineIO, emptyLineState } from "@/lib/line/memoryIO";
import { defaultLineSettings, type LineLink } from "@/lib/line/types";
import { manualTextError } from "@/lib/line/manual";
import { createRateLimiter, clientKey } from "@/lib/line/rateLimit";

const NOW = Date.parse("2026-11-08T03:00:00Z");
const ATTACKER = "U" + "a".repeat(32), VICTIM = "U" + "b".repeat(32);
const S = "aaaaaaaa-0000-0000-0000-000000000001";
const link = (uid: string, cid: string | null, via: LineLink["linked_via"] = "token"): LineLink => ({ id: uid, store_id: S, line_user_id: uid, customer_id: cid, followed: true, opted_out: false, linked_at: "2026-11-01T00:00:00Z", linked_via: via });
const bk = (o: Partial<{ customer_id: string | null; created_at: string; customer_created: boolean | null }> = {}) => ({ customer_id: "cust-1", created_at: new Date(NOW - 60_000).toISOString(), customer_created: false, ...o });

describe("bookingLinkDecision（LINE予約のあとの自動連携・0020）", () => {
  it("その予約で新しく作られたお客様 → つなぐ（booking_new）", () => {
    expect(bookingLinkDecision({ booking: bk({ customer_created: true }), lineUserId: ATTACKER, existingLink: null, now: NOW })).toEqual({ kind: "link", customerId: "cust-1", via: "booking_new" });
  });
  it("既存のお客様で、まだ LINE がつながっていない → つながず確認待ち", () => {
    expect(bookingLinkDecision({ booking: bk(), lineUserId: ATTACKER, existingLink: null, now: NOW })).toEqual({ kind: "request", customerId: "cust-1" });
  });
  it("既存のお客様に別の LINE がつながっている → つながず確認待ち（付け替えない）", () => {
    expect(bookingLinkDecision({ booking: bk(), lineUserId: ATTACKER, existingLink: link(VICTIM, "cust-1"), now: NOW })).toEqual({ kind: "request", customerId: "cust-1" });
  });
  it("つながっているのが自分（同じ LINE）なら、何も変えない", () => {
    expect(bookingLinkDecision({ booking: bk(), lineUserId: VICTIM, existingLink: link(VICTIM, "cust-1"), now: NOW })).toEqual({ kind: "already", customerId: "cust-1" });
  });
  it("0019 より前の予約（customer_created が null/undefined）は「新規ではない」扱い＝確認待ち", () => {
    expect(bookingLinkDecision({ booking: bk({ customer_created: null }), lineUserId: ATTACKER, existingLink: null, now: NOW }).kind).toBe("request");
    expect(bookingLinkDecision({ booking: bk({ customer_created: undefined }), lineUserId: ATTACKER, existingLink: null, now: NOW }).kind).toBe("request");
  });
  it("予約が無い・お客様なし・2時間を過ぎた → 410", () => {
    expect(bookingLinkDecision({ booking: null, lineUserId: ATTACKER, existingLink: null, now: NOW })).toMatchObject({ kind: "error", status: 410 });
    expect(bookingLinkDecision({ booking: bk({ customer_id: null }), lineUserId: ATTACKER, existingLink: null, now: NOW })).toMatchObject({ kind: "error", status: 410 });
    expect(bookingLinkDecision({ booking: bk({ customer_created: true, created_at: new Date(NOW - 3 * 3600_000).toISOString() }), lineUserId: ATTACKER, existingLink: null, now: NOW })).toMatchObject({ kind: "error", status: 410 });
  });
});

describe("prefillAllowed（/api/line/me が名前・電話・メールを返してよいか）", () => {
  it("token・booking_new・staff_approved だけ。booking・経路なし（0019 より前）・linked_at なしは返さない", () => {
    expect(prefillAllowed(link(ATTACKER, "c", "token"))).toBe(true);
    expect(prefillAllowed(link(ATTACKER, "c", "booking_new"))).toBe(true);
    expect(prefillAllowed(link(ATTACKER, "c", "staff_approved"))).toBe(true);
    expect(prefillAllowed(link(ATTACKER, "c", "booking"))).toBe(false);
    expect(prefillAllowed(link(ATTACKER, "c", null))).toBe(false);
    expect(prefillAllowed({ ...link(ATTACKER, "c", "token"), linked_at: null })).toBe(false);
    expect(prefillAllowed(link(ATTACKER, null, "token"))).toBe(false);
    expect(prefillAllowed(null)).toBe(false);
  });
  it("つなぎ直しで経路を弱くしない（token > staff_approved > booking_new > booking）", () => {
    expect(mergeLinkedVia("token", "booking")).toBe("token");
    expect(mergeLinkedVia("token", "staff_approved")).toBe("token");
    expect(mergeLinkedVia("staff_approved", "booking_new")).toBe("staff_approved");
    expect(mergeLinkedVia("booking", "staff_approved")).toBe("staff_approved");
    expect(mergeLinkedVia("booking", "booking_new")).toBe("booking_new");
    expect(mergeLinkedVia(null, "booking")).toBe("booking");
  });
});

describe("saveLink（偽のIO）：付け替えは takeOver（会計のQR）のときだけ", () => {
  const io = () => {
    const line = emptyLineState();
    line.links.push(link(VICTIM, "cust-1"));
    const x = memoryLineIO({ store: { id: S, name: "店", phone: null, slug: "s", business_type: null } as never, settings: defaultLineSettings(S), menus: [], bookings: [], customers: [], sales: [], line, now: () => new Date(NOW) });
    return { x, line };
  };
  it("LINE予約の流れ：決まりで止まれば、被害者のつながりはそのまま", async () => {
    const { x, line } = io();
    const existing = await x.linkOfCustomer("cust-1");
    const d = bookingLinkDecision({ booking: bk(), lineUserId: ATTACKER, existingLink: existing, now: NOW });
    expect(d.kind).toBe("request");
    expect(line.links.find(l => l.line_user_id === VICTIM)?.customer_id).toBe("cust-1");
    expect(line.links.some(l => l.line_user_id === ATTACKER)).toBe(false);
  });
  it("takeOver なしで同じお客様を書いても、他の LINE は外さない", async () => {
    const { x, line } = io();
    await x.saveLink({ line_user_id: ATTACKER, customer_id: "cust-1", linked_via: "booking" });
    expect(line.links.find(l => l.line_user_id === VICTIM)?.customer_id).toBe("cust-1");
  });
  it("会計のQR（takeOver）なら付け替える", async () => {
    const { x, line } = io();
    await x.saveLink({ line_user_id: ATTACKER, customer_id: "cust-1", linked_via: "token" }, { takeOver: true });
    expect(line.links.find(l => l.line_user_id === VICTIM)?.customer_id).toBeNull();
    expect(line.links.find(l => l.line_user_id === ATTACKER)?.customer_id).toBe("cust-1");
  });
});

describe("軽微な対応", () => {
  it("L7：ゼロ幅スペース・BOM・方向制御だけの本文は空扱い。絵文字だけ・記号だけは送れる", () => {
    expect(manualTextError(" ​ ")).toBe("本文が空です");
    expect(manualTextError("﻿‍‎")).toBe("本文が空です");
    expect(manualTextError("🙏")).toBeNull();
    expect(manualTextError("！")).toBeNull();
    expect(manualTextError("明日はよろしくお願いします")).toBeNull();
  });
  it("L4：トークンバケット（瞬間 capacity 回・1分で補充）", () => {
    const rl = createRateLimiter(3, 3);
    const t = 1_000_000;
    expect([rl.take("ip", t), rl.take("ip", t), rl.take("ip", t), rl.take("ip", t)]).toEqual([true, true, true, false]);
    expect(rl.take("other", t)).toBe(true);
    expect(rl.take("ip", t + 20_000)).toBe(true);    // 20秒で1回分
    expect(rl.take("ip", t + 20_000)).toBe(false);
  });
  it("L4：古いキーは捨てて増え続けない", () => {
    const rl = createRateLimiter(1, 1, 100);
    for (let i = 0; i < 1000; i++) rl.take(`k${i}`, 0);
    expect(rl.size()).toBeLessThanOrEqual(100);
  });
  it("送り元は x-forwarded-for の先頭", () => {
    expect(clientKey(new Request("http://x", { headers: { "x-forwarded-for": "1.2.3.4, 10.0.0.1" } }))).toBe("1.2.3.4");
    expect(clientKey(new Request("http://x"))).toBe("unknown");
  });
});
