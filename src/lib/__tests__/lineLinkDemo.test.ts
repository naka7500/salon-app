import { describe, it, expect, beforeAll, afterAll } from "vitest";

// デモ（メモリ）でも 0020 の流れが動く：既存のお客様の LINE予約 → 確認待ち（つながない）→ スタッフが承認 → 付け替え＋前の LINE へのお知らせ（デモ）
//   ＋ネット予約の入力で既存のお客様の名前・メールが変わらない
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
async function bookOnce(phone: string, name: string, email: string, dayOffset = 0) {
  const { memoryPublicApi } = await import("@/lib/db/memory");
  const cat = (await memoryPublicApi.menus(SLUG))!;
  const menu = cat.menus.find(m => m.target !== "repeat" && m.people === 1 && !(m.option_group_ids?.length))!;
  const from = new Date(Date.now() + (3 + dayOffset) * 86400_000).toISOString().slice(0, 10);
  const to = new Date(Date.now() + (12 + dayOffset) * 86400_000).toISOString().slice(0, 10);
  const av = (await memoryPublicApi.availability(SLUG, menu.id, from, to))!;
  const [date, times] = Object.entries(av.days).find(([, t]) => t.length)!;
  const start = new Date(`${date}T${times[0]}:00`).toISOString();   // デモは端末の時刻で数える
  return memoryPublicApi.createBooking({ slug: SLUG, menu_id: menu.id, start_at: start, name, kana: "テスト", phone, email, intake: [], lang: "ja" });
}

describe("デモ：LINE連携の確認待ち（0020）", () => {
  it("既存のお客様の LINE予約 → 確認待ち → 承認で付け替え・前の LINE にお知らせ（デモ）・登録内容は変わらない", async () => {
    const { memoryRepo, memoryPublicApi, setDemoRole } = await import("@/lib/db/memory");
    setDemoRole("owner");
    await memoryRepo.saveLineSettings({ enabled: true });
    const victim = (await memoryRepo.customers()).find(c => (c.phone || "").replace(/\D/g, "").length >= 10)!;
    expect(victim).toBeTruthy();
    // 本人の LINE がつながっている状態（デモの友だち追加＝会計のQRと同じ扱い）
    await memoryRepo.lineAction({ kind: "demo_follow", customer_id: victim.id });
    const before = (await memoryRepo.lineLinks([victim.id]))![0];
    expect(before.customer_id).toBe(victim.id);

    // 別の人が、本人の電話番号で LINE予約
    const r = await bookOnce(victim.phone!, "なりすまし太郎", "evil@example.com");
    const out = await memoryPublicApi.linkLine!({ slug: SLUG, idToken: "x", mode: "booking", cancel_token: r.cancel_token });
    expect(out).toMatchObject({ ok: false, pending: true, message: "LINEのお知らせは、ご来店時にお店で確認してからお届けします" });
    // つながりは変わらない・登録内容も変わらない・予約には入力が残る
    expect((await memoryRepo.lineLinks([victim.id]))![0].line_user_id).toBe(before.line_user_id);
    const after = await memoryRepo.customer(victim.id);
    expect(after?.name).toBe(victim.name);
    expect(after?.email ?? null).toBe(victim.email ?? null);   // 空でも予約者のメールで埋めない
    expect(after?.kana ?? null).toBe(victim.kana ?? null);
    const bk = (await memoryRepo.bookingsOfCustomer(victim.id)).find(b => b.cancel_token === r.cancel_token);
    expect(bk).toMatchObject({ customer_created: false, web_name: "なりすまし太郎", web_email: "evil@example.com" });

    // 確認待ちが出る → 承認
    const reqs = (await memoryRepo.lineLinkRequests([victim.id]))!;
    expect(reqs).toHaveLength(1);
    const res = await memoryRepo.decideLineLinkRequest(reqs[0].id, "approve");
    expect(res.ok).toBe(true);
    const now = (await memoryRepo.lineLinks([victim.id]))![0];
    expect(now.line_user_id).toBe(reqs[0].line_user_id);
    expect(now.linked_via).toBe("staff_approved");
    const msgs = (await memoryRepo.lineMessages())!;
    expect(msgs.find(m => m.kind === "link_notice")).toMatchObject({ line_user_id: before.line_user_id, status: "demo", text: "KOKAGE西五反田のお知らせの送り先が変更されました。心当たりがない場合はお店にご連絡ください。" });
    // もう決まったので2回目はだめ・一覧から消える
    await expect(memoryRepo.decideLineLinkRequest(reqs[0].id, "reject")).rejects.toThrow(/もう決まっています/);
    expect(await memoryRepo.lineLinkRequests([victim.id])).toEqual([]);
  });

  it("新しい電話番号の LINE予約は、そのままつなぐ（booking_new）", async () => {
    const { memoryRepo, memoryPublicApi } = await import("@/lib/db/memory");
    store["salon-app-demo-line-uid"] = "U" + "c".repeat(32);
    const r = await bookOnce("09011112222", "新規花子", "new@example.com", 1);
    const out = await memoryPublicApi.linkLine!({ slug: SLUG, idToken: "x", mode: "booking", cancel_token: r.cancel_token });
    expect(out.ok).toBe(true);
    const c = (await memoryRepo.customers()).find(x => x.name === "新規花子")!;
    expect((await memoryRepo.lineLinks([c.id]))![0]).toMatchObject({ linked_via: "booking_new", line_user_id: "U" + "c".repeat(32) });
  });

  it("C7：LINE予約で作られたお客様に別の予約が寄ると、持ち主の確認待ち（お知らせ停止）。「つながない」はつながりを変えず、「合っている」で再開", async () => {
    const { memoryRepo, memoryPublicApi } = await import("@/lib/db/memory");
    const C_UID = "U" + "c".repeat(32), D_UID = "U" + "d".repeat(32);
    store["salon-app-demo-line-uid"] = D_UID;
    const c = (await memoryRepo.customers()).find(x => x.name === "新規花子")!;
    const r = await bookOnce("09011112222", "別人", "x@example.com", 2);
    expect((await memoryPublicApi.linkLine!({ slug: SLUG, idToken: "x", mode: "booking", cancel_token: r.cancel_token })).pending).toBe(true);
    expect((await memoryRepo.lineLinks([c.id]))![0]).toMatchObject({ line_user_id: C_UID, needs_confirm: true });
    const reqs = (await memoryRepo.lineLinkRequests([c.id]))!;
    expect(reqs.map(q => q.line_user_id).sort()).toEqual([C_UID, D_UID]);
    expect(await memoryRepo.decideLineLinkRequest(reqs.find(q => q.line_user_id === D_UID)!.id, "reject")).toMatchObject({ ok: true });
    expect((await memoryRepo.lineLinks([c.id]))![0].line_user_id).toBe(C_UID);
    await memoryRepo.decideLineLinkRequest(reqs.find(q => q.line_user_id === C_UID)!.id, "approve");
    expect((await memoryRepo.lineLinks([c.id]))![0]).toMatchObject({ line_user_id: C_UID, needs_confirm: false, linked_via: "staff_approved" });
  });

  it("C1：来店歴で決まる条件（新規限定クーポン）は断らずに受けて「要確認」。S1：キャンセル画面は入力した名前だけ", async () => {
    const { memoryRepo, memoryPublicApi } = await import("@/lib/db/memory");
    const cat = (await memoryPublicApi.menus(SLUG))!;
    const cp = cat.coupons.find(x => x.target === "new" && !x.has_code)!;
    expect(cp).toBeTruthy();
    const victim = (await memoryRepo.customers()).find(c => (c.phone || "").replace(/\D/g, "").length >= 10 && c.name !== "新規花子")!;
    const r = await bookOnce(victim.phone!, "名乗り", "q@example.com", 4);
    expect((await memoryPublicApi.bookingByToken(r.cancel_token))?.customer_name).toBe("名乗り");
    {
      const menuId = cp.menu_ids?.[0] ?? cat.menus[0].id;
      const from = new Date(Date.now() + 6 * 86400_000).toISOString().slice(0, 10), to = new Date(Date.now() + 20 * 86400_000).toISOString().slice(0, 10);
      const av = (await memoryPublicApi.availability(SLUG, menuId, from, to, cp.id))!;
      const [date, times] = Object.entries(av.days).find(([, t]) => t.length)!;
      const b = await memoryPublicApi.createBooking({ slug: SLUG, menu_id: menuId, start_at: new Date(`${date}T${times[0]}:00`).toISOString(), name: "名乗り", kana: "ナノリ", phone: victim.phone!, email: "q@example.com", intake: [], lang: "ja", coupon_id: cp.id });
      const bk = (await memoryRepo.bookingsOfCustomer(victim.id)).find(x => x.cancel_token === b.cancel_token)!;
      expect(bk.web_check).toMatch(/新規クーポンの対象外の可能性/);
    }
  });
});
