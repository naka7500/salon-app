// オーナー決定 2026-11-08（0020）：LINE予約が既存のお客様に当たったら「確認待ち」。スタッフの承認でつなぐ・付け替えたら前の LINE に知らせる
import { describe, it, expect } from "vitest";
import { applyLink, type LinkApplyIO } from "@/lib/line/linkApply";
import { decideRequestError, openRequests, repointNoticeText, shouldNotifyOld, requestExpired, REPOINT_NOTICE_KIND, type LineLinkRequest } from "@/lib/line/linkPolicy";
import { memoryLineIO, emptyLineState } from "@/lib/line/memoryIO";
import { defaultLineSettings, type LineLink, type LineMessage } from "@/lib/line/types";
import type { LineSender } from "@/lib/line/engine";

const NOW = Date.parse("2026-11-08T03:00:00Z");
const ATTACKER = "U" + "a".repeat(32), VICTIM = "U" + "b".repeat(32);
const S = "aaaaaaaa-0000-0000-0000-000000000001";
const link = (uid: string, cid: string | null, o: Partial<LineLink> = {}): LineLink => ({ id: `link-${uid.slice(1, 4)}`, store_id: S, line_user_id: uid, customer_id: cid, followed: true, opted_out: false, linked_at: "2026-11-01T00:00:00Z", linked_via: "token", ...o });

/** 偽の送信（記録だけ） */
function fakeSender(fail = false) {
  const pushed: { to: string; text: string }[] = [];
  const sender: LineSender = {
    async push(to, msgs) { if (fail) throw new Error("LINE push 400: blocked"); pushed.push({ to, text: msgs.map(m => (m.type === "text" ? m.text : m.altText)).join("\n") }); },
    async reply() {},
  };
  return { sender, pushed };
}
/** 偽の IO（メモリの LINE のつながり＋監査ログ） */
function fakeIO(links: LineLink[], used = 0) {
  const line = emptyLineState();
  line.links.push(...links);
  const base = memoryLineIO({ store: { id: S, name: "ラシエル箱崎", phone: null, slug: "s", business_type: null } as never, settings: defaultLineSettings(S), menus: [], bookings: [], customers: [], sales: [], line, now: () => new Date(NOW) });
  const audits: { action: string; after: Record<string, unknown> }[] = [];
  const io: LinkApplyIO = {
    linkOfCustomer: base.linkOfCustomer, linkByUser: base.linkByUser, saveLink: base.saveLink,
    logMessage: base.logMessage, monthCount: async () => used, async audit(action, after) { audits.push({ action, after }); },
  };
  return { io, line, audits, messages: line.messages as LineMessage[] };
}
const input = (o: Partial<Parameters<typeof applyLink>[2]> = {}) => ({ storeId: S, storeName: "ラシエル箱崎", planLimit: 200, lineUserId: ATTACKER, displayName: "あいうえ", customerId: "cust-1", via: "staff_approved" as const, takeOver: true, logText: "test", ids: { request_id: "req-1" }, now: new Date(NOW), ...o });

describe("applyLink：承認で付け替える → 前の LINE に知らせる", () => {
  it("前の LINE（友だち・停止なし）に「送り先が変更されました」を1通送り、つながりは新しい LINE に移る", async () => {
    const { io, line, audits, messages } = fakeIO([link(VICTIM, "cust-1")]);
    const { sender, pushed } = fakeSender();
    const r = await applyLink(io, sender, input());
    expect(r).toMatchObject({ repointed: true, notice: "sent", linkedVia: "staff_approved" });
    expect(pushed).toEqual([{ to: VICTIM, text: repointNoticeText("ラシエル箱崎") }]);
    expect(pushed[0].text).toBe("ラシエル箱崎のお知らせの送り先が変更されました。心当たりがない場合はお店にご連絡ください。");
    expect(line.links.find(l => l.line_user_id === VICTIM)?.customer_id).toBeNull();
    expect(line.links.find(l => l.line_user_id === ATTACKER)).toMatchObject({ customer_id: "cust-1", linked_via: "staff_approved" });
    // 通数に数える送信として記録
    expect(messages.find(m => m.kind === REPOINT_NOTICE_KIND)).toMatchObject({ line_user_id: VICTIM, direction: "out", status: "sent", counted: true });
    // 監査ログは ID だけ（LINEのユーザーID・表示名は入れない）
    expect(audits).toEqual([{ action: "link_repoint", after: expect.objectContaining({ customer_id: "cust-1", old_link_id: "link-bbb", via: "staff_approved", notice: "sent", request_id: "req-1" }) }]);
    expect(JSON.stringify(audits)).not.toContain(VICTIM);
    expect(JSON.stringify(audits)).not.toContain(ATTACKER);
    expect(JSON.stringify(audits)).not.toContain("あいうえ");
  });
  it("前の LINE がお知らせ停止・ブロック中なら送らない", async () => {
    for (const old of [link(VICTIM, "cust-1", { opted_out: true }), link(VICTIM, "cust-1", { followed: false })]) {
      const { io } = fakeIO([old]);
      const { sender, pushed } = fakeSender();
      const r = await applyLink(io, sender, input());
      expect(r).toMatchObject({ repointed: true, notice: "skipped_not_sendable" });
      expect(pushed).toEqual([]);
    }
  });
  it("今月の通数の上限なら送らない（記録は skipped・通数に数えない）", async () => {
    const { io, messages } = fakeIO([link(VICTIM, "cust-1")], 200);
    const { sender, pushed } = fakeSender();
    const r = await applyLink(io, sender, input());
    expect(r.notice).toBe("skipped_quota");
    expect(pushed).toEqual([]);
    expect(messages.find(m => m.kind === REPOINT_NOTICE_KIND)).toMatchObject({ status: "skipped", counted: false });
  });
  it("送れなくても（ブロック等）つながりは移る・failed で記録", async () => {
    const { io, line, messages } = fakeIO([link(VICTIM, "cust-1")]);
    const r = await applyLink(io, fakeSender(true).sender, input());
    expect(r.notice).toBe("failed");
    expect(line.links.find(l => l.line_user_id === ATTACKER)?.customer_id).toBe("cust-1");
    expect(messages.find(m => m.kind === REPOINT_NOTICE_KIND)).toMatchObject({ status: "failed", counted: false });
  });
  it("前のつながりが無い・同じ LINE なら付け替えではない（何も送らない・link_create）", async () => {
    const a = fakeIO([]); const fa = fakeSender();
    expect(await applyLink(a.io, fa.sender, input())).toMatchObject({ repointed: false, notice: null });
    expect(a.audits[0].action).toBe("link_create");
    const b = fakeIO([link(ATTACKER, "cust-1", { linked_via: "token" })]); const fb = fakeSender();
    const r = await applyLink(b.io, fb.sender, input());
    expect(r).toMatchObject({ repointed: false, notice: null, linkedVia: "token" });   // 経路は弱くしない
    expect(fa.pushed.length + fb.pushed.length).toBe(0);
  });
  it("LINE予約の新規のお客様（takeOver なし）は前の LINE を外さない", async () => {
    const { io, line } = fakeIO([]);
    await applyLink(io, fakeSender().sender, input({ via: "booking_new", takeOver: false, customerId: "new-cust" }));
    expect(line.links.find(l => l.line_user_id === ATTACKER)).toMatchObject({ customer_id: "new-cust", linked_via: "booking_new" });
  });
});

describe("確認待ちの決まり", () => {
  const req = (o: Partial<LineLinkRequest> = {}): LineLinkRequest => ({ id: "r1", store_id: S, customer_id: "c1", line_user_id: ATTACKER, created_at: new Date(NOW - 86400_000).toISOString(), status: "pending", ...o });
  it("在籍の owner・manager・staff だけ決められる（viewer・不明は 403）", () => {
    for (const role of ["owner", "manager", "staff"]) expect(decideRequestError({ role, request: req(), now: NOW })).toBeNull();
    for (const role of ["viewer", null, undefined, ""]) expect(decideRequestError({ role, request: req(), now: NOW })?.status).toBe(403);
  });
  it("見つからない 404・決まったもの 409・30日を過ぎた 410", () => {
    expect(decideRequestError({ role: "staff", request: null, now: NOW })?.status).toBe(404);
    expect(decideRequestError({ role: "staff", request: req({ status: "approved" }), now: NOW })?.status).toBe(409);
    expect(decideRequestError({ role: "staff", request: req({ status: "rejected" }), now: NOW })?.status).toBe(409);
    expect(decideRequestError({ role: "staff", request: req({ created_at: new Date(NOW - 31 * 86400_000).toISOString() }), now: NOW })?.status).toBe(410);
    expect(requestExpired(req({ created_at: new Date(NOW - 29 * 86400_000).toISOString() }), NOW)).toBe(false);
  });
  it("画面に出すのは pending で30日以内だけ", () => {
    const rs = [req(), req({ id: "r2", status: "approved" }), req({ id: "r3", created_at: new Date(NOW - 40 * 86400_000).toISOString() })];
    expect(openRequests(rs, NOW).map(r => r.id)).toEqual(["r1"]);
  });
  it("前の LINE に知らせる条件", () => {
    expect(shouldNotifyOld(link(VICTIM, "c"), ATTACKER)).toBe(true);
    expect(shouldNotifyOld(link(VICTIM, "c"), VICTIM)).toBe(false);
    expect(shouldNotifyOld(null, ATTACKER)).toBe(false);
    expect(shouldNotifyOld(link(VICTIM, "c", { opted_out: true }), ATTACKER)).toBe(false);
  });
});

describe("予約時の入力と登録内容の違い（0020）", async () => {
  const { webInputDiffs } = await import("@/lib/webInput");
  const c = { name: "山田 花子", kana: "ヤマダ ハナコ", phone: "090-1234-5678", email: "hana@example.com" };
  it("同じ（空白・全角半角・+81・大文字小文字の違いは同じ）なら何も出さない", () => {
    expect(webInputDiffs({ web_name: "山田花子", web_kana: "ﾔﾏﾀﾞﾊﾅｺ", web_phone: "+81 90 1234 5678", web_email: "Hana@Example.com" }, c)).toEqual([]);
  });
  it("名前・メールが違えば出す。入力の無い項目は比べない", () => {
    expect(webInputDiffs({ web_name: "なりすまし", web_phone: "09012345678", web_email: "evil@example.com" }, c).map(d => d.field)).toEqual(["name", "email"]);
    expect(webInputDiffs({}, c)).toEqual([]);
  });
  it("登録のメールが空なら「未登録」として出す（自動で埋めないので）", () => {
    expect(webInputDiffs({ web_email: "a@example.com" }, { ...c, email: null })).toEqual([{ field: "email", label: "メール", typed: "a@example.com", stored: "（未登録）" }]);
  });
});
