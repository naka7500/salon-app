import { describe, it, expect, beforeEach } from "vitest";

describe("LINEのAPIは、サーバの鍵が無ければ何もしない（501）", () => {
  beforeEach(() => { delete process.env.SUPABASE_SERVICE_ROLE_KEY; delete process.env.CRON_SECRET; });
  it("webhook", async () => {
    const { POST } = await import("@/app/api/line/webhook/[storeId]/route");
    const r = await POST(new Request("http://x/api/line/webhook/abc", { method: "POST", body: "{}" }), { params: Promise.resolve({ storeId: "abc" }) });
    expect(r.status).toBe(501);
  });
  it("cron（合言葉も無い）", async () => {
    const { GET } = await import("@/app/api/line/cron/route");
    expect((await GET(new Request("http://x/api/line/cron"))).status).toBe(501);
  });
  it("cron（鍵はあるが合言葉が違う）→ 401", async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "http://localhost:1"; process.env.SUPABASE_SERVICE_ROLE_KEY = "x"; process.env.CRON_SECRET = "s3cret";
    const { GET } = await import("@/app/api/line/cron/route");
    expect((await GET(new Request("http://x/api/line/cron", { headers: { authorization: "Bearer nope" } }))).status).toBe(401);
  });
  it("link / admin", async () => {
    const link = await import("@/app/api/line/link/route");
    expect((await link.POST(new Request("http://x", { method: "POST", body: "{}" }))).status).toBe(501);
    const admin = await import("@/app/api/line/admin/route");
    expect((await admin.POST(new Request("http://x", { method: "POST", body: "{}" }))).status).toBe(501);
  });
  it("admin の手動送信（push_customer）：ログインしていなければ 401（DBに触る前に止まる）", async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "http://localhost:1"; process.env.SUPABASE_SERVICE_ROLE_KEY = "x";
    const admin = await import("@/app/api/line/admin/route");
    const r = await admin.POST(new Request("http://x", { method: "POST", body: JSON.stringify({ kind: "push_customer", store_id: "aaaaaaaa-0000-0000-0000-000000000001", items: [] }) }));
    expect(r.status).toBe(401);
  });
  it("admin の顧客詳細からの送信（push_customer_direct）：ログインしていなければ 401", async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "http://localhost:1"; process.env.SUPABASE_SERVICE_ROLE_KEY = "x";
    const admin = await import("@/app/api/line/admin/route");
    const r = await admin.POST(new Request("http://x", { method: "POST", body: JSON.stringify({ kind: "push_customer_direct", store_id: "aaaaaaaa-0000-0000-0000-000000000001", customer_id: "cccccccc-0000-4000-8000-000000000001", text: "こんにちは" }) }));
    expect(r.status).toBe(401);
  });
});

describe("監査対応：cron の合言葉・LIFF API の形式チェック", () => {
  it("cron：合言葉が正しい長さで1文字違い → 401（一定時間比較）", async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "http://localhost:1"; process.env.SUPABASE_SERVICE_ROLE_KEY = "x"; process.env.CRON_SECRET = "s3cret";
    const { GET } = await import("@/app/api/line/cron/route");
    expect((await GET(new Request("http://x/api/line/cron", { headers: { authorization: "Bearer s3creT" } }))).status).toBe(401);
    expect((await GET(new Request("http://x/api/line/cron"))).status).toBe(401);
  });
  it("me / link：IDトークンが JWT の形でなければ DB・LINE に触る前に 400", async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "http://localhost:1"; process.env.SUPABASE_SERVICE_ROLE_KEY = "x";
    const me = await import("@/app/api/line/me/route");
    const r = await me.POST(new Request("http://x", { method: "POST", headers: { "x-forwarded-for": "9.9.9.1" }, body: JSON.stringify({ slug: "s", idToken: "not-a-jwt" }) }));
    expect(r.status).toBe(400);
    const link = await import("@/app/api/line/link/route");
    const r2 = await link.POST(new Request("http://x", { method: "POST", headers: { "x-forwarded-for": "9.9.9.1" }, body: JSON.stringify({ slug: "s", idToken: "x", mode: "booking", cancel_token: "a".repeat(64) }) }));
    expect(r2.status).toBe(400);
  });
  it("me：同じ送り元から短時間に多すぎると 429", async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "http://localhost:1"; process.env.SUPABASE_SERVICE_ROLE_KEY = "x";
    const me = await import("@/app/api/line/me/route");
    const statuses: number[] = [];
    for (let i = 0; i < 25; i++) statuses.push((await me.POST(new Request("http://x", { method: "POST", headers: { "x-forwarded-for": "9.9.9.2" }, body: JSON.stringify({ slug: "s", idToken: "bad" }) }))).status);
    expect(statuses.slice(0, 20).every(s => s === 400)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
  });
});
