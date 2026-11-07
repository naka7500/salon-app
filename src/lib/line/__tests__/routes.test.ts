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
});
