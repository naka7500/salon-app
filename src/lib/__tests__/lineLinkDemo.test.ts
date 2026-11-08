import { describe, it, expect, beforeAll, afterAll } from "vitest";

// デモ（メモリ）でも 0022（案B）の流れが動く：
//  ・LINEの中の予約（lineBook）は LINE のユーザーIDが本人 → 既存のお客様の電話番号でも新しいお客様・被害者には触れない・LINE がつながる
//  ・同じ LINE の2回目は同じお客様／同じ電話番号のヒント／スタッフが「統合する」で1人にまとめる
//  ・ブラウザの予約（createBooking）は 0020 のまま：電話番号でつながるが登録内容は変えない・新規クーポンは要確認・キャンセル画面は入力した名前
const store: Record<string, string> = {};
beforeAll(() => {
  (globalThis as unknown as { window: unknown }).window = globalThis;
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; },
    clear: () => { for (const k of Object.keys(store)) delete store[k]; }, key: i => Object.keys(store)[i] ?? null, get length() { return Object.keys(store).length; },
  } as Storage;
});
afterAll(() => { delete (globalThis as { window?: unknown }).window; delete (globalThis as { localStorage?: unknown }).localStorage; });

const SLUG = "kokage-gotanda";
async function slotFor(dayOffset: number, couponId?: string) {
  const { memoryPublicApi } = await import("@/lib/db/memory");
  const cat = (await memoryPublicApi.menus(SLUG))!;
  const menu = couponId ? cat.menus.find(m => cat.coupons.find(c => c.id === couponId)!.menu_ids.includes(m.id)) || cat.menus[0] : cat.menus.find(m => m.target !== "repeat" && m.people === 1 && !(m.option_group_ids?.length))!;
  const from = new Date(Date.now() + (3 + dayOffset) * 86400_000).toISOString().slice(0, 10);
  const to = new Date(Date.now() + (12 + dayOffset) * 86400_000).toISOString().slice(0, 10);
  const av = (await memoryPublicApi.availability(SLUG, menu.id, from, to, couponId))!;
  const [date, times] = Object.entries(av.days).find(([, t]) => t.length)!;
  return { menu, start: new Date(`${date}T${times[0]}:00`).toISOString() };   // デモは端末の時刻で数える
}
async function bookWeb(phone: string, name: string, email: string, dayOffset = 0) {
  const { memoryPublicApi } = await import("@/lib/db/memory");
  const { menu, start } = await slotFor(dayOffset);
  return memoryPublicApi.createBooking({ slug: SLUG, menu_id: menu.id, start_at: start, name, kana: "テスト", phone, email, intake: [], lang: "ja" });
}
async function bookLine(phone: string, name: string, email: string, dayOffset = 0) {
  const { memoryPublicApi } = await import("@/lib/db/memory");
  const { menu, start } = await slotFor(dayOffset);
  return memoryPublicApi.lineBook!({ slug: SLUG, idToken: "demo", menu_id: menu.id, start_at: start, name, kana: "テスト", phone, email, intake: [], lang: "ja" });
}

describe("デモ：案B（0022）LINE予約の本人＝LINEのユーザーID", () => {
  it("知らない LINE が既存のお客様の電話番号で LINE予約 → 新しいお客様・被害者の情報と LINE は変わらない・要確認「同じ電話番号」", async () => {
    const { memoryRepo, memoryPublicApi } = await import("@/lib/db/memory");
    await memoryRepo.saveLineSettings({ enabled: true });
    const victim = (await memoryRepo.customers()).find(c => (c.phone || "").replace(/\D/g, "").length >= 10)!;
    expect(victim).toBeTruthy();
    await memoryRepo.lineAction({ kind: "demo_follow", customer_id: victim.id });   // 本人の LINE（会計のQRと同じ扱い）
    const before = (await memoryRepo.lineLinks([victim.id]))![0];
    expect(before.customer_id).toBe(victim.id);

    store["salon-app-demo-line-uid"] = "U" + "a".repeat(32);   // 攻撃者の LINE
    const r = await bookLine(victim.phone!, "なりすまし太郎", "evil@example.com");
    expect(r.line).toEqual({ linked: true, customer_created: true });
    const attacker = (await memoryRepo.customers()).find(c => c.name === "なりすまし太郎")!;
    expect(attacker).toBeTruthy(); expect(attacker.id).not.toBe(victim.id);
    expect((await memoryRepo.lineLinks([attacker.id]))![0]).toMatchObject({ line_user_id: "U" + "a".repeat(32), linked_via: "line_id" });
    expect((await memoryRepo.lineLinks([victim.id]))![0].line_user_id).toBe(before.line_user_id);
    const after = await memoryRepo.customer(victim.id);
    expect(after?.name).toBe(victim.name); expect(after?.email ?? null).toBe(victim.email ?? null);
    const bk = (await memoryRepo.bookingsOfCustomer(attacker.id)).find(b => b.cancel_token === r.cancel_token)!;
    expect(bk).toMatchObject({ customer_created: true, web_name: "なりすまし太郎", web_check: "同じ電話番号のお客様がいます" });
    expect(bk.note).toContain("（LINE）");
    expect((await memoryRepo.bookingsOfCustomer(victim.id)).some(b => b.cancel_token === r.cancel_token)).toBe(false);
    expect(await memoryRepo.lineLinkRequests([victim.id])).toEqual([]);   // 確認待ちは作らない
    expect((await memoryPublicApi.bookingByToken(r.cancel_token))?.customer_name).toBe("なりすまし太郎");
  });

  it("同じ LINE の2回目は同じお客様（別の名前・番号でも新しいお客様は作らない）", async () => {
    const { memoryRepo } = await import("@/lib/db/memory");
    store["salon-app-demo-line-uid"] = "U" + "a".repeat(32);
    const r = await bookLine("080-0000-0000", "なりすまし次郎", "evil2@example.com", 1);
    expect(r.line.customer_created).toBe(false);
    const list = (await memoryRepo.customers()).filter(c => c.name.startsWith("なりすまし"));
    expect(list).toHaveLength(1);
    expect((await memoryRepo.bookingsOfCustomer(list[0].id))).toHaveLength(2);
  });

  it("同じ電話番号のヒント → スタッフが「統合する」：予約・LINE が残す側に移り、もう一方は統合済み。閲覧のみは統合できない", async () => {
    const { memoryRepo, setDemoRole } = await import("@/lib/db/memory");
    const victim = (await memoryRepo.customers()).find(c => (c.phone || "").replace(/\D/g, "").length >= 10 && !c.name.startsWith("なりすまし"))!;
    const attacker = (await memoryRepo.customers()).find(c => c.name === "なりすまし太郎")!;
    const dups = (await memoryRepo.customersSamePhone(victim.id))!;
    expect(dups.map(c => c.id)).toContain(attacker.id);
    const nb = (await memoryRepo.bookingsOfCustomer(victim.id)).length;
    setDemoRole("staff");
    const res = await memoryRepo.mergeCustomers(victim.id, attacker.id);
    expect(res).toMatchObject({ ok: true, kept_id: victim.id, line: "kept" });   // 両方に LINE → 残す側（本人）の LINE を残す
    expect((await memoryRepo.bookingsOfCustomer(victim.id))).toHaveLength(nb + 2);
    expect((await memoryRepo.customer(attacker.id))?.merged_into).toBe(victim.id);
    expect((await memoryRepo.customers()).some(c => c.id === attacker.id)).toBe(false);   // 一覧から消える
    expect(await memoryRepo.lineLinks([attacker.id])).toEqual([]);
    expect(await memoryRepo.customersSamePhone(victim.id)).toEqual([]);
    await expect(memoryRepo.mergeCustomers(victim.id, attacker.id)).rejects.toThrow(/もう統合/);
    const logs = await memoryRepo.auditLogs("2000-01-01", "2999-01-01");
    expect(logs!.find(a => a.action === "merge")).toMatchObject({ table_name: "customers", row_id: victim.id });
    // 攻撃者の LINE で3回目 → つながりは外れているので、また新しいお客様
    const r3 = await bookLine("070-0000-0000", "なりすまし三郎", "evil3@example.com", 2);
    expect(r3.line.customer_created).toBe(true);
    setDemoRole("owner");
  });

  it("ブラウザの予約（LINE以外）は 0020 のまま：電話番号でつながるが登録内容は変えない・新規クーポンは要確認・LINE はつながらない", async () => {
    const { memoryRepo, memoryPublicApi } = await import("@/lib/db/memory");
    const cat = (await memoryPublicApi.menus(SLUG))!;
    const cp = cat.coupons.find(x => x.target === "new" && !x.has_code)!;
    expect(cp).toBeTruthy();
    // 上の筋書きで使った人は電話番号ごとの上限（1時間3件）に当たるので、別のお客様で
    const used = new Set((await memoryRepo.lineLinks())!.map(l => l.customer_id));
    const victim = (await memoryRepo.customers()).find(c => (c.phone || "").replace(/\D/g, "").length >= 10 && !c.name.startsWith("なりすまし") && !used.has(c.id))!;
    const linksBefore = (await memoryRepo.lineLinks())!.length;
    const r = await bookWeb(victim.phone!, "名乗り", "q@example.com", 4);
    const bk = (await memoryRepo.bookingsOfCustomer(victim.id)).find(x => x.cancel_token === r.cancel_token)!;
    expect(bk).toMatchObject({ customer_created: false, web_name: "名乗り", web_email: "q@example.com" });
    expect((await memoryRepo.customer(victim.id))?.email ?? null).toBe(victim.email ?? null);
    expect((await memoryPublicApi.bookingByToken(r.cancel_token))?.customer_name).toBe("名乗り");
    expect((await memoryRepo.lineLinks())!.length).toBe(linksBefore);
    {
      const { menu, start } = await slotFor(6, cp.id);
      const b = await memoryPublicApi.createBooking({ slug: SLUG, menu_id: menu.id, start_at: start, name: "名乗り", kana: "ナノリ", phone: victim.phone!, email: "q@example.com", intake: [], lang: "ja", coupon_id: cp.id });
      expect((await memoryRepo.bookingsOfCustomer(victim.id)).find(x => x.cancel_token === b.cancel_token)!.web_check).toMatch(/新規クーポンの対象外の可能性/);
    }
  });
});
