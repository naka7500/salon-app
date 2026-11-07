import { describe, it, expect, beforeEach } from "vitest";
import { generateTempPassword, TEMP_ALPHABET, TEMP_PASSWORD_BITS, checkNewPassword, loginPermissionError, loginStatusOf, plusAddress, isValidEmail } from "@/lib/staffLogin";
import { loginAction, loginStatus, changeOwnPassword, HttpError, type LoginDeps, type StaffRow, type AuditRow, type NewStaffRow } from "@/lib/staffLoginServer";
import { passwordStrength, emailWords } from "@/lib/staffLogin";

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
  const audits: AuditRow[] = []; const revoked: string[] = []; const inserted: NewStaffRow[] = [];
  const deps: LoginDeps = {
    configured: true, inviteEnabled: false,
    async authUser(j) { const u = users[tokens[j]]; return u ? { id: u.id, email: u.email } : null; },
    async roleIn(j, company) { const uid = tokens[j]; const r = staff.filter(s => s.auth_user_id === uid && s.company_id === company && s.active !== false && !users[uid]?.banned); return r[0]?.role ?? null; },
    async storeCompany(s) { return s === ST ? C : null; },
    async staffById(x) { return staff.find(s => s.id === x) ?? null; },
    async staffOfCompany(c) { return staff.filter(s => s.company_id === c); },
    async staffByAuth(a) { return staff.filter(s => s.auth_user_id === a); },
    async authInfo(ids, emails) { return Object.values(users).filter(u => ids.includes(u.id) || emails.includes(u.email)).map(u => ({ id: u.id, email: u.email, last_sign_in_at: u.must ? null : "2026-11-01T00:00:00Z", banned_until: u.banned ? "2126-01-01T00:00:00Z" : null, must_change: u.must })); },
    async createAuthUser(email, pw, must = true) { const nid = `u-${Object.keys(users).length + 1}`; users[nid] = { id: nid, email, banned: false, must, pw }; return nid; },
    async insertStaff(row) { const nid = `5f000000-0000-0000-0000-0000000001${String(staff.length).padStart(2, "0")}`; staff.push({ id: nid, company_id: row.company_id, name: row.name, role: row.role, active: true, email: row.email, auth_user_id: row.auth_user_id, home_store_id: row.home_store_id }); inserted.push(row); return nid; },
    async inviteAuthUser() { throw new Error("no"); },
    async deleteAuthUser(x) { delete users[x]; },
    async setPassword(a, pw, must) { users[a].pw = pw; users[a].must = must; },
    async setBan(a, b) { users[a].banned = b; },
    async revokeSessions(a) { revoked.push(a); return true; },
    async linkStaff(sid, a, email) { const s = staff.find(x => x.id === sid)!; s.auth_user_id = a; s.email = email; },
    async recentIssueCount(c) { return audits.filter(x => x.company_id === c && ["login_issue", "login_invite", "login_reset", "user_create", "user_password"].includes(x.action)).length; },
    async audit(r) { audits.push(r); },
    async history() { return []; },
    ...over,
  };
  return { deps, staff, users, audits, revoked, inserted };
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
  it("同じメールのログインがある → 聞き返す → つなぐ（どの会社にもつながっていないログインだけ。パスワードは変えない）", async () => {
    const f = fake();
    f.users["u-other"] = { id: "u-other", email: "other@x.jp", banned: false, must: false, pw: "keep-this-pw" };
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

// ---------------------------------------------------------------------------
// 設定＞ユーザー：オーナーが決めたパスワードでユーザーを作る・パスワードを変える
// ---------------------------------------------------------------------------
describe("パスワードの決まり（オーナーが決める・自分で決める 共通）", () => {
  it("短い・よくある・並び・繰り返し・空白は断る", () => {
    for (const pw of ["Abc-12345", "qwerty1234", "letmein123", "abcdefghijkl", "9876543210", "abcabcabcabc", "12121212121", "kokage2026!", "Password123", "has space 12345"]) expect(checkNewPassword(pw), pw).toBeTruthy();
    expect(checkNewPassword("Kp7m-Qx4r-Tz9w")).toBeNull();
    expect(checkNewPassword("Mori-no-Kokage-77")).toBeNull();
  });
  it("メールの @ の前（＋や . の部分も）が入っていたら断る", () => {
    expect(emailWords("kokage.store+takesue@gmail.com")).toEqual(expect.arrayContaining(["takesue", "store", "kokage"]));
    expect(checkNewPassword("Takesue-8849x", "kokage.store+takesue@gmail.com")).toMatch(/メール/);
    expect(checkNewPassword("Hanako#2026xy", "hanako@example.com")).toMatch(/メール/);
    expect(checkNewPassword("Zq8-Wn4-Pr6m", "hanako@example.com")).toBeNull();
  });
  it("強さの目安", () => {
    expect(passwordStrength("").level).toBe(0);
    expect(passwordStrength("short").level).toBe(0);
    expect(passwordStrength("mountainriver").level).toBeGreaterThanOrEqual(1);
    expect(passwordStrength("Kp7m-Qx4r-Tz9w").level).toBe(3);
  });
});

describe("権限：ユーザーの追加・パスワードの変更", () => {
  const staff = { id: "s1", role: "staff" as const, active: true, auth_user_id: "u1" };
  const owner2 = { id: "o2", role: "owner" as const, active: true, auth_user_id: "uo2" };
  it("オーナーだけ。店長・スタッフはできない", () => {
    expect(loginPermissionError("set_password", { staff_id: "o1", role: "owner" }, staff)).toBeNull();
    expect(loginPermissionError("set_password", { staff_id: "m1", role: "manager" }, staff)).toMatch(/オーナーだけ/);
    expect(loginPermissionError("create_user", { staff_id: "m1", role: "manager" }, staff)).toMatch(/オーナーだけ/);
    expect(loginPermissionError("set_password", { staff_id: "x", role: "staff" }, staff)).toMatch(/オーナー・店長/);
  });
  it("自分・ほかのオーナー・退職した人にはできない", () => {
    expect(loginPermissionError("set_password", { staff_id: "s1", role: "owner" }, staff)).toMatch(/自分/);
    expect(loginPermissionError("set_password", { staff_id: "o1", role: "owner" }, owner2)).toMatch(/オーナーのログイン/);
    expect(loginPermissionError("set_password", { staff_id: "o1", role: "owner" }, { ...staff, active: false })).toMatch(/退職/);
  });
});

describe("サーバ：設定＞ユーザー", () => {
  const PW = "Hinoki-Mori-58";
  const base = { kind: "create_user" as const, name: "テスト花子", role: "staff" as const, email: "Test.Hanako@Example.com", password: PW, must_change: true, store_id: ST };
  it("オーナーが新しい人を作る：スタッフ行＋ログイン（メール確認済み）。パスワードは返事にも記録にも入らない", async () => {
    const f = fake();
    const r = await loginAction(f.deps, "jwt-owner", base, "https://app.example");
    expect(r.ok).toBe(true);
    expect(r.email).toBe("test.hanako@example.com");
    expect(r.temp_password).toBeUndefined();
    expect(JSON.stringify(r)).not.toContain(PW);
    const s = f.staff.find(x => x.id === r.staff_id)!;
    expect(s).toMatchObject({ name: "テスト花子", role: "staff", company_id: C, home_store_id: ST, email: "test.hanako@example.com" });
    expect(f.users[s.auth_user_id!]).toMatchObject({ pw: PW, must: true });
    expect(f.audits).toHaveLength(1);
    expect(f.audits[0]).toMatchObject({ action: "user_create", actor_staff_id: id(1), row_id: s.id, company_id: C, store_id: ST });
    expect(JSON.stringify(f.audits)).not.toContain(PW);
    expect(JSON.stringify(f.inserted)).not.toContain(PW);
  });
  it("「最初のログインで変えてもらう」オフ → 仮パスワードの印を付けない", async () => {
    const f = fake();
    const r = await loginAction(f.deps, "jwt-owner", { ...base, must_change: false, show_on_ledger: false });
    const s = f.staff.find(x => x.id === r.staff_id)!;
    expect(f.users[s.auth_user_id!].must).toBe(false);
    expect(f.inserted[0].show_on_ledger).toBe(false);
    expect(f.audits[0].after).toMatchObject({ must_change: false });
  });
  it("店長・スタッフは作れない（サーバでも止まる）。オーナーは作れない・変な役割は断る", async () => {
    const f = fake();
    expect((await err(loginAction(f.deps, "jwt-mgr", base)))?.status).toBe(403);
    expect((await err(loginAction(f.deps, "jwt-tomi", base)))?.status).toBe(403);
    expect((await err(loginAction(f.deps, "jwt-owner", { ...base, role: "owner" as never })))?.status).toBe(400);
    expect((await err(loginAction(f.deps, "jwt-owner", { ...base, role: "viewer" as never })))?.status).toBe(400);
    expect(f.staff).toHaveLength(5); expect(f.audits).toHaveLength(0);
  });
  it("弱いパスワード・メールと同じ言葉は断る（何も作らない）", async () => {
    const f = fake();
    expect((await err(loginAction(f.deps, "jwt-owner", { ...base, password: "password12" })))?.status).toBe(400);
    expect((await err(loginAction(f.deps, "jwt-owner", { ...base, password: "Hanako-77-xy" })))?.message).toMatch(/メール/);
    expect((await err(loginAction(f.deps, "jwt-owner", { ...base, name: "  " })))?.status).toBe(400);
    expect(Object.keys(f.users)).toHaveLength(3);
  });
  it("同じメールのログインがある → やさしく断る（作らない）", async () => {
    const f = fake();
    f.users["u-other"] = { id: "u-other", email: "other@x.jp", banned: false, must: false };
    const r = await loginAction(f.deps, "jwt-owner", { ...base, email: "other@x.jp" });
    expect(r).toMatchObject({ ok: false, code: "email_exists" });
    expect(r.message).toMatch(/別のメール/);
    expect(f.staff).toHaveLength(5);
    // 同じ会社のスタッフのメールは 409
    expect((await err(loginAction(f.deps, "jwt-owner", { ...base, email: "mgr@x.jp" })))?.status).toBe(409);
  });
  it("Supabase 側で「もうある」になった場合も、やさしく断る", async () => {
    const f = fake({ async createAuthUser() { throw new HttpError(409, "x", "email_exists"); } });
    const r = await loginAction(f.deps, "jwt-owner", base);
    expect(r).toMatchObject({ ok: false, code: "email_exists" });
  });
  it("スタッフ行が作れなければ、作ったログインを消す", async () => {
    const f = fake({ async insertStaff() { throw new HttpError(409, "dup"); } });
    expect((await err(loginAction(f.deps, "jwt-owner", base)))?.status).toBe(409);
    expect(Object.values(f.users).some(u => u.email === "test.hanako@example.com")).toBe(false);
  });
  it("ログインの無い今のスタッフにつなぐ（名前・役割は今のまま）", async () => {
    const f = fake();
    const r = await loginAction(f.deps, "jwt-owner", { ...base, staff_id: id(4), name: "ちがう名前", role: "manager" });
    expect(r.ok).toBe(true); expect(r.staff_id).toBe(id(4));
    const s = f.staff.find(x => x.id === id(4))!;
    expect(s).toMatchObject({ name: "新人", role: "staff", email: "test.hanako@example.com" });
    expect(s.auth_user_id).toBeTruthy();
    expect(f.staff).toHaveLength(5);
    // もうログインがある人・オーナー・自分にはつなげない
    expect((await err(loginAction(f.deps, "jwt-owner", { ...base, email: "z@x.jp", staff_id: id(3) })))?.status).toBe(409);
    expect((await err(loginAction(f.deps, "jwt-owner", { ...base, email: "z@x.jp", staff_id: id(1) })))?.status).toBe(403);
  });
  it("ほかの会社の店舗・スタッフには作れない", async () => {
    const f = fake();
    expect((await err(loginAction(f.deps, "jwt-owner", { ...base, staff_id: id(5) })))?.status).toBe(403);   // 別会社の人（その会社ではオーナーでない）
    expect((await err(loginAction(f.deps, "jwt-owner", { ...base, store_id: "50000000-0000-0000-0000-000000000099" })))?.status).toBe(404);
  });
  it("1時間10回まで（発行・再設定と合わせて）", async () => {
    const f = fake();
    for (let i = 0; i < 10; i++) f.audits.push({ actor: "u-owner", actor_staff_id: id(1), actor_name: "増美", store_id: ST, row_id: id(3), action: "user_create", company_id: C });
    expect((await err(loginAction(f.deps, "jwt-owner", base)))?.status).toBe(429);
  });
  it("パスワードを変更：オーナーだけ・自分は不可・今のログインを切る・パスワードは記録しない", async () => {
    const f = fake();
    const c = await loginAction(f.deps, "jwt-owner", { ...base, must_change: false });
    const uid = f.staff.find(x => x.id === c.staff_id)!.auth_user_id!;
    const NEW = "Kusunoki-Wind-31";
    const r = await loginAction(f.deps, "jwt-owner", { kind: "set_password", staff_id: c.staff_id!, password: NEW, must_change: false });
    expect(r.ok).toBe(true);
    expect(JSON.stringify(r)).not.toContain(NEW);
    expect(f.users[uid]).toMatchObject({ pw: NEW, must: false });
    expect(f.revoked).toContain(uid);
    await loginAction(f.deps, "jwt-owner", { kind: "set_password", staff_id: c.staff_id!, password: "Sakura-Stone-64", must_change: true });
    expect(f.users[uid].must).toBe(true);
    expect(f.audits.filter(a => a.action === "user_password")).toHaveLength(2);
    expect(JSON.stringify(f.audits)).not.toContain(NEW);
    expect(JSON.stringify(f.audits)).not.toContain("Sakura-Stone-64");
    expect((await err(loginAction(f.deps, "jwt-mgr", { kind: "set_password", staff_id: c.staff_id!, password: NEW, must_change: true })))?.status).toBe(403);
    expect((await err(loginAction(f.deps, "jwt-owner", { kind: "set_password", staff_id: id(1), password: NEW, must_change: true })))?.message).toMatch(/自分/);
    expect((await err(loginAction(f.deps, "jwt-owner", { kind: "set_password", staff_id: c.staff_id!, password: "short", must_change: true })))?.status).toBe(400);
    expect((await err(loginAction(f.deps, "jwt-owner", { kind: "set_password", staff_id: id(4), password: NEW, must_change: true })))?.status).toBe(400);   // ログインなし
    expect((await err(loginAction(f.deps, "jwt-owner", { kind: "set_password", staff_id: id(3), password: NEW, must_change: true })))?.status).toBe(409);   // 別の会社でも使っている
  });
  it("オーナーは自分を止められない", async () => {
    const f = fake();
    expect((await err(loginAction(f.deps, "jwt-owner", { kind: "stop", staff_id: id(1) })))?.message).toMatch(/自分/);
    expect(f.users["u-owner"].banned).toBe(false);
  });
});

describe("APIの経路：パスワードを console に出さない", { timeout: 20000 }, () => {
  it("失敗しても body（パスワード）はログに出ない", async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:9"; process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon"; process.env.SUPABASE_SERVICE_ROLE_KEY = "svc";
    const logs: string[] = []; const orig = { e: console.error, l: console.log, w: console.warn };
    console.error = (...a: unknown[]) => { logs.push(a.map(String).join(" ")); }; console.log = console.error; console.warn = console.error;
    try {
      const a = await import("@/app/api/staff/login/route");
      const SECRET = "Secret-Pine-9182";
      const r = await a.POST(new Request("http://x", { method: "POST", headers: { authorization: "Bearer bad" }, body: JSON.stringify({ kind: "create_user", name: "x", role: "staff", email: "a@b.jp", password: SECRET, must_change: true, store_id: ST }) }));
      expect(r.status).toBeGreaterThanOrEqual(400);
      expect(await r.text()).not.toContain(SECRET);
      expect(logs.join("\n")).not.toContain(SECRET);
    } finally {
      console.error = orig.e; console.log = orig.l; console.warn = orig.w;
      delete process.env.NEXT_PUBLIC_SUPABASE_URL; delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY; delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    }
  });
});

// ---------------------------------------------------------------------------
// 監査 2026-11-07 M1〜M3
// ---------------------------------------------------------------------------
describe("監査対応：オーナー保護・メール一致での停止・他社ログインのつなぎ", () => {
  const owner2 = { id: "o2", role: "owner" as const, active: true, auth_user_id: "uo2" };
  it("M1：オーナーは別のオーナーのログインを発行・招待・再設定できない（止める・再開はできる）", () => {
    expect(loginPermissionError("reset", { staff_id: "o1", role: "owner" }, owner2)).toMatch(/オーナーのログイン/);
    expect(loginPermissionError("issue", { staff_id: "o1", role: "owner" }, owner2)).toMatch(/オーナーのログイン/);
    expect(loginPermissionError("invite", { staff_id: "o1", role: "owner" }, owner2)).toMatch(/オーナーのログイン/);
    expect(loginPermissionError("stop", { staff_id: "o1", role: "owner" }, owner2)).toBeNull();
    expect(loginPermissionError("resume", { staff_id: "o1", role: "owner" }, owner2)).toBeNull();
  });
  it("M1（サーバ）：別のオーナーの再設定は 403、パスワードは変わらない", async () => {
    const f = fake();
    f.users["u-o2"] = { id: "u-o2", email: "o2@x.jp", banned: false, must: false, pw: "orig" };
    f.staff.push({ id: id(7), company_id: C, name: "共同オーナー", role: "owner", active: true, email: "o2@x.jp", auth_user_id: "u-o2", home_store_id: ST });
    expect((await err(loginAction(f.deps, "jwt-owner", { kind: "reset", staff_id: id(7) })))?.status).toBe(403);
    expect(f.users["u-o2"].pw).toBe("orig");
  });
  it("M2：ログイン未連携のスタッフのメール欄が他人のアドレスでも、そのログインは止めない", async () => {
    const f = fake();
    f.users["u-victim"] = { id: "u-victim", email: "victim@other.jp", banned: false, must: false };
    f.staff.find(x => x.id === id(4))!.email = "victim@other.jp";
    const r = await loginAction(f.deps, "jwt-owner", { kind: "stop", staff_id: id(4), reason: "retire" });
    expect(r.status).toBe("none");
    expect(f.users["u-victim"].banned).toBe(false);
    expect(f.revoked).not.toContain("u-victim");
  });
  it("M3：別の会社のスタッフにつながっているログインは、つながない（409・やさしい文言）", async () => {
    const f = fake();
    f.users["u-other"] = { id: "u-other", email: "other@x.jp", banned: false, must: false };
    f.staff.push({ id: id(6), company_id: C2, name: "別会社の人", role: "staff", active: true, email: "other@x.jp", auth_user_id: "u-other" });
    const e = await err(loginAction(f.deps, "jwt-owner", { kind: "issue", staff_id: id(4), email: "other@x.jp", link_existing: true }));
    expect(e?.status).toBe(409);
    expect(e?.message).toBe("このメールは別の会社ですでに使われています。別のメールを使ってください");
    expect(f.staff.find(x => x.id === id(4))!.auth_user_id).toBeNull();
    // 退職済み（active=false）の他社行でも同じ（行が残っている＝その会社が管理している）
    f.staff.find(x => x.id === id(6))!.active = false;
    expect((await err(loginAction(f.deps, "jwt-owner", { kind: "issue", staff_id: id(4), email: "other@x.jp", link_existing: true })))?.status).toBe(409);
  });
});
