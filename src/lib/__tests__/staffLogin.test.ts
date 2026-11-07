import { describe, it, expect, beforeEach } from "vitest";
import { generateTempPassword, TEMP_ALPHABET, TEMP_PASSWORD_BITS, checkNewPassword, loginPermissionError, loginStatusOf, plusAddress, isValidEmail } from "@/lib/staffLogin";
import { loginAction, loginStatus, changeOwnPassword, HttpError, type LoginDeps, type StaffRow, type AuditRow } from "@/lib/staffLoginServer";

describe("仮パスワード", { timeout: 20000 }, () => {
  it("12文字（区切り2つ）・大文字小文字数字が全部入る・見間違えやすい文字なし", () => {
    for (let i = 0; i < 500; i++) {
      const p = generateTempPassword();
      expect(p).toMatch(/^[A-Za-z2-9]{4}-[A-Za-z2-9]{4}-[A-Za-z2-9]{4}$/);
      const s = p.replace(/-/g, "");
      expect(s).toHaveLength(12);
      expect(s).toMatch(/[A-Z]/); expect(s).toMatch(/[a-z]/); expect(s).toMatch(/[2-9]/);
      expect(s).not.toMatch(/[0O1lIo]/);
    }
  });
  it("強さ：64ビット以上・同じものが出ない", () => {
    expect(TEMP_PASSWORD_BITS).toBeGreaterThan(64);
    const set = new Set(Array.from({ length: 5000 }, () => generateTempPassword()));
    expect(set.size).toBe(5000);
  });
  it("文字の出かたに大きな偏りがない（棄却法）", () => {
    const count: Record<string, number> = {};
    for (let i = 0; i < 4000; i++) for (const c of generateTempPassword().replace(/-/g, "")) count[c] = (count[c] || 0) + 1;
    const exp = (4000 * 12) / TEMP_ALPHABET.length;
    for (const c of TEMP_ALPHABET) { expect(count[c]).toBeGreaterThan(exp * 0.7); expect(count[c]).toBeLessThan(exp * 1.3); }
  });
  it("乱数が偏っても（同じ値ばかり）条件を満たすまで作り直す", () => {
    let k = 0; const rnd = (n: number) => Uint8Array.from({ length: n }, () => (k++ * 37) % 256);
    expect(generateTempPassword(rnd)).toMatch(/^[A-Za-z2-9]{4}-[A-Za-z2-9]{4}-[A-Za-z2-9]{4}$/);
  });
});

describe("自分で決めるパスワード・メール", () => {
  it("10文字以上・弱いものは断る", () => {
    expect(checkNewPassword("short")).toMatch(/10文字/);
    expect(checkNewPassword("aaaaaaaaaaaa")).toMatch(/同じ文字/);
    expect(checkNewPassword("password12")).toMatch(/よく使われる/);
    expect(checkNewPassword("1234567890")).toBeTruthy();
    expect(checkNewPassword("takesue-2026x", "takesue@example.com")).toMatch(/メール/);
    expect(checkNewPassword("Kp7m-Qx4r-Tz9w")).toBeNull();
  });
  it("お店のGmail＋名前", () => {
    expect(plusAddress("kokage.store@gmail.com", "Kana Takesue")).toBe("kokage.store+kanatakesue@gmail.com");
    expect(plusAddress("kokage.store+x@gmail.com", null, 3)).toBe("kokage.store+staff3@gmail.com");
    expect(plusAddress("info@kokage.jp", "a")).toBeNull();
    expect(isValidEmail("store+takesue@gmail.com")).toBe(true);
    expect(isValidEmail("bad@x")).toBe(false);
  });
  it("状態の判定", () => {
    expect(loginStatusOf(null)).toBe("none");
    expect(loginStatusOf({ id: "u", last_sign_in_at: null })).toBe("invited");
    expect(loginStatusOf({ id: "u", last_sign_in_at: "2026-11-01T00:00:00Z", must_change: true })).toBe("invited");
    expect(loginStatusOf({ id: "u", last_sign_in_at: "2026-11-01T00:00:00Z" })).toBe("active");
    expect(loginStatusOf({ id: "u", last_sign_in_at: "2026-11-01T00:00:00Z", banned_until: "2126-01-01T00:00:00Z" })).toBe("stopped");
    expect(loginStatusOf({ id: "u", last_sign_in_at: "2026-11-01T00:00:00Z", banned_until: "2020-01-01T00:00:00Z" })).toBe("active");
  });
});

describe("権限（誰が誰に何をできるか）", () => {
  const staff = { id: "s1", role: "staff" as const, active: true, auth_user_id: "u1" };
  const owner = { id: "o1", role: "owner" as const, active: true, auth_user_id: "uo" };
  it("発行・再設定・再開はオーナーだけ", () => {
    expect(loginPermissionError("issue", { staff_id: "o1", role: "owner" }, staff)).toBeNull();
    expect(loginPermissionError("issue", { staff_id: "m1", role: "manager" }, staff)).toMatch(/オーナーだけ/);
    expect(loginPermissionError("reset", { staff_id: "m1", role: "manager" }, staff)).toMatch(/オーナーだけ/);
    expect(loginPermissionError("resume", { staff_id: "m1", role: "manager" }, staff)).toMatch(/オーナーだけ/);
    expect(loginPermissionError("issue", { staff_id: "x", role: "staff" }, staff)).toMatch(/オーナー・店長/);
    expect(loginPermissionError("stop", { staff_id: "x", role: "viewer" }, staff)).toMatch(/オーナー・店長/);
  });
  it("止めるのはオーナー・店長。店長はオーナーを止められない", () => {
    expect(loginPermissionError("stop", { staff_id: "m1", role: "manager" }, staff)).toBeNull();
    expect(loginPermissionError("stop", { staff_id: "m1", role: "manager" }, owner)).toMatch(/オーナーだけ/);
    expect(loginPermissionError("stop", { staff_id: "o2", role: "owner" }, owner)).toBeNull();
  });
  it("自分は止められない・変えられない（staff_id でも auth のIDでも）", () => {
    expect(loginPermissionError("stop", { staff_id: "o1", role: "owner" }, owner)).toMatch(/自分/);
    expect(loginPermissionError("reset", { staff_id: "other-row", auth_user_id: "uo", role: "owner" }, owner)).toMatch(/自分/);
  });
  it("退職した人には発行・再開できない（止めるのはできる）", () => {
    const retired = { ...staff, active: false };
    expect(loginPermissionError("issue", { staff_id: "o1", role: "owner" }, retired)).toMatch(/退職/);
    expect(loginPermissionError("resume", { staff_id: "o1", role: "owner" }, retired)).toMatch(/退職/);
    expect(loginPermissionError("stop", { staff_id: "m1", role: "manager" }, retired)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// サーバの処理（偽の部品で）
// ---------------------------------------------------------------------------
const C = "c0000000-0000-0000-0000-000000000001", C2 = "c0000000-0000-0000-0000-000000000002";
const ST = "50000000-0000-0000-0000-000000000001";
const id = (n: number) => `5f000000-0000-0000-0000-00000000000${n}`;
function fake(over: Partial<LoginDeps> = {}) {
  const staff: StaffRow[] = [
    { id: id(1), company_id: C, name: "増美", role: "owner", active: true, email: "owner@x.jp", auth_user_id: "u-owner", home_store_id: ST },
    { id: id(2), company_id: C, name: "店長", role: "manager", active: true, email: "mgr@x.jp", auth_user_id: "u-mgr", home_store_id: ST },
    { id: id(3), company_id: C, name: "富塚", role: "staff", active: true, email: "tomi@x.jp", auth_user_id: "u-tomi", home_store_id: ST },
    { id: id(4), company_id: C, name: "新人", role: "staff", active: true, email: null, auth_user_id: null, home_store_id: ST },
    { id: id(5), company_id: C2, name: "富塚（別会社）", role: "staff", active: true, email: "tomi@x.jp", auth_user_id: "u-tomi", home_store_id: null },
  ];
  const users: Record<string, { id: string; email: string; banned: boolean; must: boolean; pw?: string }> = {
    "u-owner": { id: "u-owner", email: "owner@x.jp", banned: false, must: false }, "u-mgr": { id: "u-mgr", email: "mgr@x.jp", banned: false, must: false }, "u-tomi": { id: "u-tomi", email: "tomi@x.jp", banned: false, must: false },
  };
  const tokens: Record<string, string> = { "jwt-owner": "u-owner", "jwt-mgr": "u-mgr", "jwt-tomi": "u-tomi" };
  const audits: AuditRow[] = []; const revoked: string[] = [];
  const deps: LoginDeps = {
    configured: true, inviteEnabled: false,
    async authUser(j) { const u = users[tokens[j]]; return u ? { id: u.id, email: u.email } : null; },
    async roleIn(j, company) { const uid = tokens[j]; const r = staff.filter(s => s.auth_user_id === uid && s.company_id === company && s.active !== false && !users[uid]?.banned); return r[0]?.role ?? null; },
    async storeCompany(s) { return s === ST ? C : null; },
    async staffById(x) { return staff.find(s => s.id === x) ?? null; },
    async staffOfCompany(c) { return staff.filter(s => s.company_id === c); },
    async staffByAuth(a) { return staff.filter(s => s.auth_user_id === a); },
    async authInfo(ids, emails) { return Object.values(users).filter(u => ids.includes(u.id) || emails.includes(u.email)).map(u => ({ id: u.id, email: u.email, last_sign_in_at: u.must ? null : "2026-11-01T00:00:00Z", banned_until: u.banned ? "2126-01-01T00:00:00Z" : null, must_change: u.must })); },
    async createAuthUser(email, pw) { const nid = `u-${Object.keys(users).length + 1}`; users[nid] = { id: nid, email, banned: false, must: true, pw }; return nid; },
    async inviteAuthUser() { throw new Error("no"); },
    async deleteAuthUser(x) { delete users[x]; },
    async setPassword(a, pw, must) { users[a].pw = pw; users[a].must = must; },
    async setBan(a, b) { users[a].banned = b; },
    async revokeSessions(a) { revoked.push(a); return true; },
    async linkStaff(sid, a, email) { const s = staff.find(x => x.id === sid)!; s.auth_user_id = a; s.email = email; },
    async recentIssueCount(c) { return audits.filter(x => x.company_id === c && ["login_issue", "login_invite", "login_reset"].includes(x.action)).length; },
    async audit(r) { audits.push(r); },
    async history() { return []; },
    ...over,
  };
  return { deps, staff, users, audits, revoked };
}
const err = async (p: Promise<unknown>) => { try { await p; return null; } catch (e) { return e as HttpError; } };

describe("サーバ：ログインの発行・停止", () => {
  beforeEach(() => { delete process.env.APP_BASE_URL; delete process.env.VERCEL_PROJECT_PRODUCTION_URL; });
  it("サービスキーが無ければ 501・ログインしていなければ 401", async () => {
    const { deps } = fake({ configured: false });
    expect((await err(loginAction(deps, "jwt-owner", { kind: "stop", staff_id: id(3) })))?.status).toBe(501);
    const f = fake();
    expect((await err(loginAction(f.deps, null, { kind: "stop", staff_id: id(3) })))?.status).toBe(401);
    expect((await err(loginAction(f.deps, "jwt-bad", { kind: "stop", staff_id: id(3) })))?.status).toBe(401);
  });
  it("オーナーが発行：ユーザーを作り・つなぎ・仮パスワードは返事にだけ（記録に入らない）", async () => {
    const f = fake();
    const r = await loginAction(f.deps, "jwt-owner", { kind: "issue", staff_id: id(4), email: " Store+Shinjin@Gmail.com ", store_id: ST }, "https://app.example");
    expect(r.ok).toBe(true);
    expect(r.temp_password).toMatch(/^[A-Za-z2-9]{4}-[A-Za-z2-9]{4}-[A-Za-z2-9]{4}$/);
    expect(r.email).toBe("store+shinjin@gmail.com");
    expect(r.login_url).toBe("https://app.example/bookings?email=store%2Bshinjin%40gmail.com");
    const s = f.staff.find(x => x.id === id(4))!;
    expect(s.auth_user_id).toBeTruthy();
    expect(f.users[s.auth_user_id!].must).toBe(true);
    expect(f.audits).toHaveLength(1);
    expect(f.audits[0]).toMatchObject({ action: "login_issue", actor_staff_id: id(1), row_id: id(4), store_id: ST, company_id: C });
    expect(JSON.stringify(f.audits)).not.toContain(r.temp_password!);
  });
  it("店長・スタッフは発行できない（サーバでも止まる）", async () => {
    const f = fake();
    expect((await err(loginAction(f.deps, "jwt-mgr", { kind: "issue", staff_id: id(4), email: "a@b.jp" })))?.status).toBe(403);
    expect((await err(loginAction(f.deps, "jwt-tomi", { kind: "issue", staff_id: id(4), email: "a@b.jp" })))?.status).toBe(403);
    expect(f.audits).toHaveLength(0);
  });
  it("店長はスタッフを止められるが、オーナーは止められない。自分も止められない", async () => {
    const f = fake();
    // 別の会社でも使っているログイン（富塚）は止めない → 新人に発行してから止める
    await loginAction(f.deps, "jwt-owner", { kind: "issue", staff_id: id(4), email: "new@x.jp" });
    const r = await loginAction(f.deps, "jwt-mgr", { kind: "stop", staff_id: id(4) });
    expect(r.status).toBe("stopped");
    expect((await err(loginAction(f.deps, "jwt-mgr", { kind: "stop", staff_id: id(1) })))?.status).toBe(403);
    expect(f.users["u-owner"].banned).toBe(false);
    expect((await err(loginAction(f.deps, "jwt-owner", { kind: "stop", staff_id: id(1) })))?.message).toMatch(/自分/);
  });
  it("退職で止める：ban＋今のログインを切る＋記録（理由＝退職）", async () => {
    const f = fake();
    await loginAction(f.deps, "jwt-owner", { kind: "issue", staff_id: id(4), email: "new@x.jp" });
    const uid = f.staff.find(x => x.id === id(4))!.auth_user_id!;
    f.staff.find(x => x.id === id(4))!.active = false;           // 画面で退職にして保存した後
    const r = await loginAction(f.deps, "jwt-mgr", { kind: "stop", staff_id: id(4), reason: "retire" });
    expect(r.ok).toBe(true); expect(r.status).toBe("stopped");
    expect(f.users[uid].banned).toBe(true);
    expect(f.revoked).toContain(uid);
    expect(f.audits.at(-1)).toMatchObject({ action: "login_stop", reason: "退職", actor_staff_id: id(2) });
    // 退職した人は再開できない
    expect((await err(loginAction(f.deps, "jwt-owner", { kind: "resume", staff_id: id(4) })))?.message).toMatch(/退職/);
  });
  it("別の会社でも在籍中のログインは止めない（not_stopped）", async () => {
    const f = fake();
    const r = await loginAction(f.deps, "jwt-owner", { kind: "stop", staff_id: id(3), reason: "retire" });
    expect(r.not_stopped).toBe(true);
    expect(f.users["u-tomi"].banned).toBe(false);
  });
  it("発行していない人を止める → 何もしない", async () => {
    const f = fake();
    const r = await loginAction(f.deps, "jwt-mgr", { kind: "stop", staff_id: id(4), reason: "retire" });
    expect(r).toMatchObject({ ok: true, status: "none" });
  });
  it("同じメールのログインがある → 聞き返す → つなぐ（パスワードは変えない）", async () => {
    const f = fake();
    f.users["u-other"] = { id: "u-other", email: "other@x.jp", banned: false, must: false, pw: "keep-this-pw" };
    f.staff.push({ id: id(6), company_id: C2, name: "別会社の人", role: "staff", active: true, email: "other@x.jp", auth_user_id: "u-other" });
    const r1 = await loginAction(f.deps, "jwt-owner", { kind: "issue", staff_id: id(4), email: "other@x.jp" });
    expect(r1).toMatchObject({ ok: false, code: "email_exists" });
    expect(f.staff.find(x => x.id === id(4))!.auth_user_id).toBeNull();
    const r2 = await loginAction(f.deps, "jwt-owner", { kind: "issue", staff_id: id(4), email: "other@x.jp", link_existing: true });
    expect(r2.ok).toBe(true); expect(r2.temp_password).toBeUndefined();
    expect(f.staff.find(x => x.id === id(4))!.auth_user_id).toBe("u-other");
    expect(f.users["u-other"].pw).toBe("keep-this-pw");
    expect(f.audits.at(-1)?.action).toBe("login_link");
  });
  it("同じ会社の別のスタッフのメール・ログインは使えない（409）", async () => {
    const f = fake();
    expect((await err(loginAction(f.deps, "jwt-owner", { kind: "issue", staff_id: id(4), email: "tomi@x.jp" })))?.status).toBe(409);
    f.staff.find(x => x.id === id(3))!.email = "tomi2@x.jp";   // 行のメールは違うが、ログインは富塚さんにつながっている
    expect((await err(loginAction(f.deps, "jwt-owner", { kind: "issue", staff_id: id(4), email: "tomi@x.jp", link_existing: true })))?.status).toBe(409);
  });
  it("発行は会社ごとに1時間10回まで（429）", async () => {
    const f = fake();
    for (let i = 0; i < 10; i++) f.audits.push({ actor: "u-owner", actor_staff_id: id(1), actor_name: "増美", store_id: ST, row_id: id(3), action: "login_reset", company_id: C });
    expect((await err(loginAction(f.deps, "jwt-owner", { kind: "issue", staff_id: id(4), email: "x@y.jp" })))?.status).toBe(429);
  });
  it("パスワード再設定：仮パスワードに戻し、今のログインを切る", async () => {
    const f = fake();
    await loginAction(f.deps, "jwt-owner", { kind: "issue", staff_id: id(4), email: "new@x.jp" });
    const uid = f.staff.find(x => x.id === id(4))!.auth_user_id!;
    f.users[uid].must = false;
    const r = await loginAction(f.deps, "jwt-owner", { kind: "reset", staff_id: id(4) });
    expect(r.temp_password).toBeTruthy();
    expect(f.users[uid].pw).toBe(r.temp_password);
    expect(f.users[uid].must).toBe(true);
    expect(f.revoked).toContain(uid);
    expect(JSON.stringify(f.audits)).not.toContain(r.temp_password!);
  });
  it("一覧：オーナー・店長だけ。状態が出る", async () => {
    const f = fake();
    f.users["u-tomi"].banned = true;
    const r = await loginStatus(f.deps, "jwt-mgr", ST);
    expect(r.items.find(x => x.staff_id === id(3))?.status).toBe("stopped");
    expect(r.items.find(x => x.staff_id === id(4))?.status).toBe("none");
    expect(r.items.find(x => x.staff_id === id(1))?.status).toBe("active");
    expect((await err(loginStatus(f.deps, "jwt-tomi", ST)))?.status).toBe(403);
  });
  it("本人のパスワード変更：10文字未満は断る・変えたら仮パスワードの印が消える", async () => {
    const f = fake();
    f.users["u-tomi"].must = true;
    expect((await err(changeOwnPassword(f.deps, "jwt-tomi", "short")))?.status).toBe(400);
    await changeOwnPassword(f.deps, "jwt-tomi", "Mori-no-Kokage-77");
    expect(f.users["u-tomi"].must).toBe(false);
    expect(JSON.stringify(f.audits)).not.toContain("Mori-no-Kokage-77");
  });
});

describe("APIは、サーバの鍵が無ければ何もしない（501）", { timeout: 20000 }, () => {
  beforeEach(() => { delete process.env.SUPABASE_SERVICE_ROLE_KEY; });
  it("login / password", async () => {
    const a = await import("@/app/api/staff/login/route");
    const r = await a.POST(new Request("http://x", { method: "POST", body: JSON.stringify({ kind: "status" }) }));
    expect(r.status).toBe(501);
    expect(r.headers.get("cache-control")).toContain("no-store");
    const b = await import("@/app/api/staff/password/route");
    expect((await b.POST(new Request("http://x", { method: "POST", body: "{}" }))).status).toBe(501);
  });
});
