import { afterEach, describe, expect, it } from "vitest";
import { notifyConfigured, plainText, safeEqual, sendBlockReason } from "../send";

describe("通知メール（C5）", () => {
  const keep = { ...process.env };
  afterEach(() => { process.env = { ...keep }; });
  it("鍵がそろっていても NOTIFY_SEND_ENABLED=true が無ければ送らない", () => {
    Object.assign(process.env, { NEXT_PUBLIC_SUPABASE_URL: "https://x.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "k", RESEND_API_KEY: "r", NOTIFY_FROM: "a@b.jp" });
    delete process.env.NOTIFY_SEND_ENABLED;
    expect(notifyConfigured()).toBe(false);
    process.env.NOTIFY_SEND_ENABLED = "true";
    expect(notifyConfigured()).toBe(true);
  });
  it("送る種類はお客様・お店への予約の通知だけ。宛先の形も確かめる", () => {
    expect(sendBlockReason({ id: "1", to_address: "a@b.jp", subject: "s", body: "b", kind: "booking_confirmation", channel: "email" })).toBeNull();
    expect(sendBlockReason({ id: "1", to_address: "a@b.jp", subject: "s", body: "b", kind: "hpb_attention", channel: "email" })).not.toBeNull();
    expect(sendBlockReason({ id: "1", to_address: "a@b.jp", subject: "s", body: "b", kind: null })).not.toBeNull();
    expect(sendBlockReason({ id: "1", to_address: "a@b.jp, c@d.jp", subject: "s", body: "b", kind: "new_booking" })).not.toBeNull();
    expect(sendBlockReason({ id: "1", to_address: null, subject: "s", body: "b", kind: "new_booking" })).not.toBeNull();
  });
  it("本文は文字だけ・長さを切る", () => {
    expect(plainText('<a href="https://evil">click</a>本文\u0007', 100)).toBe("click本文");
    expect(plainText("x".repeat(5000), 4000)).toHaveLength(4000);
  });
  it("合言葉の比較", () => {
    expect(safeEqual("Bearer abc", "Bearer abc")).toBe(true);
    expect(safeEqual("Bearer abd", "Bearer abc")).toBe(false);
    expect(safeEqual("Bearer ab", "Bearer abc")).toBe(false);
  });
  it("24時間より前に積まれた通知は送らない（あとから送信をオンにしても、古い予約確認が一斉に出ない。監査 M8）", () => {
    const now = Date.parse("2026-12-10T03:00:00Z");
    const m = { id: "1", to_address: "a@b.jp", subject: "s", body: "b", kind: "booking_confirmation", channel: "email" };
    expect(sendBlockReason({ ...m, created_at: "2026-12-09T04:00:00Z" }, now)).toBeNull();          // 23時間前
    expect(sendBlockReason({ ...m, created_at: "2026-12-09T02:00:00Z" }, now)).toContain("古い通知");   // 25時間前
    expect(sendBlockReason({ ...m, created_at: "2026-12-01T00:00:00Z" }, now)).toContain("古い通知");
    expect(sendBlockReason(m, now)).toBeNull();                                                      // 日時が分からないものは今までどおり
  });
});
