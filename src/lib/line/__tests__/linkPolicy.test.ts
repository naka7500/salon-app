// 監査 2026-11-07 R1 → オーナー決定 案B（0022）：LINE予約は LINE のユーザーIDが本人。電話番号だけで他人のお客様情報・LINE連携を取れないこと
import { describe, it, expect } from "vitest";
import { bookErrorForClient, canMerge, duplicateHint, lineBookInputError, mergeLinkedVia, normPhoneDigits, prefillAllowed, samePhoneCustomers } from "@/lib/line/linkPolicy";
import { memoryLineIO, emptyLineState } from "@/lib/line/memoryIO";
import { defaultLineSettings, type LineLink } from "@/lib/line/types";
import { manualTextError } from "@/lib/line/manual";
import { createRateLimiter, clientKey } from "@/lib/line/rateLimit";

const NOW = Date.parse("2026-11-08T03:00:00Z");
const ATTACKER = "U" + "a".repeat(32), VICTIM = "U" + "b".repeat(32);
const S = "aaaaaaaa-0000-0000-0000-000000000001";
const link = (uid: string, cid: string | null, via: LineLink["linked_via"] = "token"): LineLink => ({ id: uid, store_id: S, line_user_id: uid, customer_id: cid, followed: true, opted_out: false, linked_at: "2026-11-01T00:00:00Z", linked_via: via });

describe("案B（0022）：LINE予約の本人＝LINEのユーザーID。電話番号では既存のお客様につながない", () => {
  it("/api/line/book の入力：形が違えば DB・LINE に触る前に止める", () => {
    const ok = { slug: "laciel-hakozaki", idToken: "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4eHh4eCJ9.c2lnbmF0dXJlLXh4eA", menu_id: "11111111-1111-4111-8111-111111111111", start_at: "2026-11-20T01:00:00.000Z", name: "山田", kana: "ヤマダ", phone: "090-1111-2222", email: "a@x.jp", intake: [], lang: "ja" as const };
    expect(lineBookInputError(ok)).toBeNull();
    expect(lineBookInputError({ ...ok, option_ids: ["22222222-2222-4222-8222-222222222222"], coupon_id: "33333333-3333-4333-8333-333333333333", staff_id: null, code: "ABC" })).toBeNull();
    expect(lineBookInputError(null)).toBe("bad_request");
    expect(lineBookInputError({ ...ok, idToken: "not-a-jwt" })).toBe("bad_request");
    expect(lineBookInputError({ ...ok, slug: "" })).toBe("bad_request");
    expect(lineBookInputError({ ...ok, menu_id: "x" })).toBe("menu_not_found");
    expect(lineBookInputError({ ...ok, start_at: "いつか" })).toBe("invalid_start");
    expect(lineBookInputError({ ...ok, phone: 123 })).toBe("invalid_phone");
    expect(lineBookInputError({ ...ok, name: "あ".repeat(201) })).toBe("invalid_name");
    expect(lineBookInputError({ ...ok, coupon_id: "not-uuid" })).toBe("coupon_invalid");
    expect(lineBookInputError({ ...ok, option_ids: Array(11).fill("22222222-2222-4222-8222-222222222222") })).toBe("option_invalid");
    expect(lineBookInputError({ ...ok, lang: "fr" })).toBe("bad_request");
    expect(lineBookInputError({ ...ok, intake: Array(31).fill({ label: "a", answer: "b" }) })).toBe("invalid_intake");
  });
  it("DB のエラー名だけお客様に返す（表やIDの名前が入った文は返さない）", () => {
    expect(bookErrorForClient("slot_taken")).toBe("slot_taken");
    expect(bookErrorForClient("too_many")).toBe("too_many");
    expect(bookErrorForClient('duplicate key value violates unique constraint "line_links_customer_key"')).toBe("うまくいきませんでした（時間をおいてもう一度）");
    expect(bookErrorForClient(null)).toBe("うまくいきませんでした（時間をおいてもう一度）");
  });
  it("同じ電話番号のお客様（統合されていない・同じ会社・8桁以上）。+81 も同じ番号とみなす", () => {
    const me = { id: "a", phone: "090-1111-2222", company_id: "co" };
    const all = [me, { id: "b", phone: "09011112222", company_id: "co" }, { id: "c", phone: "+81 90 1111 2222", company_id: "co" }, { id: "d", phone: "09011112222", company_id: "co", merged_into: "a" }, { id: "e", phone: "09011112222", company_id: "other" }, { id: "f", phone: "0900000000", company_id: "co" }];
    expect(samePhoneCustomers(me, all).map(c => c.id)).toEqual(["b", "c"]);
    expect(samePhoneCustomers({ id: "z", phone: "1234567", company_id: "co" }, all)).toEqual([]);
    expect(normPhoneDigits("+81-90-1111-2222")).toBe("09011112222");
    expect(duplicateHint("被害 花子", 3)).toBe("同じ電話番号のお客様がいます：被害 花子様（来店3回）");
  });
  it("統合できるのは在籍の owner・manager・staff", () => {
    expect(canMerge("owner")).toBe(true); expect(canMerge("manager")).toBe(true); expect(canMerge("staff")).toBe(true);
    expect(canMerge("viewer")).toBe(false); expect(canMerge(null)).toBe(false);
  });
});

describe("prefillAllowed（/api/line/me が名前・電話・メールを返してよいか）", () => {
  it("line_id・token・booking_new・staff_approved だけ。booking・経路なし（0019 より前）・linked_at なし・持ち主の確認中は返さない", () => {
    expect(prefillAllowed(link(ATTACKER, "c", "line_id"))).toBe(true);
    expect(prefillAllowed({ ...link(ATTACKER, "c", "line_id"), needs_confirm: true })).toBe(false);
    expect(prefillAllowed(link(ATTACKER, "c", "token"))).toBe(true);
    expect(prefillAllowed(link(ATTACKER, "c", "booking_new"))).toBe(true);
    expect(prefillAllowed(link(ATTACKER, "c", "staff_approved"))).toBe(true);
    expect(prefillAllowed(link(ATTACKER, "c", "booking"))).toBe(false);
    expect(prefillAllowed(link(ATTACKER, "c", null))).toBe(false);
    expect(prefillAllowed({ ...link(ATTACKER, "c", "token"), linked_at: null })).toBe(false);
    expect(prefillAllowed(link(ATTACKER, null, "token"))).toBe(false);
    expect(prefillAllowed(null)).toBe(false);
  });
  it("つなぎ直しで経路を弱くしない（token > staff_approved = line_id > booking_new > booking）", () => {
    expect(mergeLinkedVia("token", "line_id")).toBe("token");
    expect(mergeLinkedVia("booking_new", "line_id")).toBe("line_id");
    expect(mergeLinkedVia("line_id", "booking_new")).toBe("line_id");
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
