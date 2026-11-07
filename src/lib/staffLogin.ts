// スタッフのログイン（設定＞スタッフ「ログインの発行」）の共通部品。画面・サーバ・デモ・テストで同じ決まりを使う。
// ここには秘密を置かない。仮パスワードは作って返すだけ（保存・ログ出力はしない）。
import type { StaffRole } from "./db/types";

/** ログインの状態：未発行／招待済み（まだ自分のパスワードにしていない）／ログイン可／停止中 */
export type LoginStatus = "none" | "invited" | "active" | "stopped";
export const LOGIN_STATUS_LABEL: Record<LoginStatus, string> = { none: "未発行", invited: "招待済み", active: "ログイン可", stopped: "停止中" };

export interface StaffLoginInfo {
  staff_id: string;
  status: LoginStatus;
  email?: string | null;
  /** 最後にログインした日時 */
  last_sign_in_at?: string | null;
  /** 仮パスワードのまま（初回に変更が必要） */
  must_change?: boolean;
  /** 同じログインを別の会社でも使っている（その会社では止められない） */
  shared?: boolean;
}
export interface StaffLoginHistory { at: string; action: string; actor_name?: string | null; target_name?: string | null; reason?: string | null }
export interface StaffLoginStatusResult {
  /** サーバの設定（SUPABASE_SERVICE_ROLE_KEY）があり、発行・停止ができる */
  server: boolean;
  /** 招待メール（Supabase の inviteUserByEmail）を使える（SMTP を設定した店だけ） */
  invite_enabled: boolean;
  items: StaffLoginInfo[];
  history?: StaffLoginHistory[];
  message?: string;
  demo?: boolean;
}
export type StaffLoginAction =
  | { kind: "issue"; staff_id: string; email: string; link_existing?: boolean }
  | { kind: "invite"; staff_id: string; email: string }
  | { kind: "reset"; staff_id: string }
  | { kind: "stop"; staff_id: string; reason?: "retire" | "manual" }
  | { kind: "resume"; staff_id: string }
  /** 設定＞ユーザー：オーナーが名前・役割・メール・パスワード（自分で決める）でユーザーを作る。staff_id ありなら、ログインの無い今のスタッフにつなぐ */
  | { kind: "create_user"; name: string; role: UserRole; email: string; password: string; must_change: boolean; staff_id?: string; show_on_ledger?: boolean }
  /** 設定＞ユーザー：オーナーが決めたパスワードに変える（must_change＝次のログインで本人に変えてもらう） */
  | { kind: "set_password"; staff_id: string; password: string; must_change: boolean };
export type StaffLoginKind = StaffLoginAction["kind"];
/** 設定＞ユーザーで選べる役割（オーナーは作れない） */
export type UserRole = "staff" | "manager";
export const USER_ROLES: UserRole[] = ["staff", "manager"];
export const isUserRole = (r: unknown): r is UserRole => r === "staff" || r === "manager";
export interface StaffLoginResult {
  ok: boolean;
  message: string;
  /** 仮パスワード：この1回だけ画面に出す（保存しない） */
  temp_password?: string;
  email?: string;
  login_url?: string;
  status?: LoginStatus;
  /** デモ（本物のログインは作っていない） */
  demo?: boolean;
  /** email_exists：そのメールのログインがもうある（つなぐかどうか聞く） */
  code?: string;
  /** 止めようとしたが止めていない（別の会社でも使っている等） */
  not_stopped?: boolean;
  /** 設定＞ユーザー：作った・変えたスタッフ */
  staff_id?: string;
}

export const ACTION_JA: Record<string, string> = {
  login_issue: "ログインを発行", login_invite: "招待メールを送った", login_link: "今のログインをつないだ", login_reset: "パスワードを再設定",
  login_stop: "ログインを止めた", login_resume: "ログインを再開", password_changed: "自分のパスワードを変更",
  user_create: "ユーザーを追加", user_password: "パスワードを変更（オーナーが決めた）",
};
/** 発行・再設定・招待は、会社ごとに1時間10回まで */
export const ISSUE_LIMIT_PER_HOUR = 10;
/** 自分で決めるパスワードの最低文字数 */
export const MIN_PASSWORD = 10;
/** Supabase の ban の長さ（実質ずっと）。再開で 'none' に戻す */
export const BAN_FOREVER = "876000h";

// ---------------------------------------------------------------------------
// 仮パスワード：見間違えやすい文字（0 O o 1 l I）を使わない 12文字＋区切り2つ（例：Kp7m-Qx4r-Tz9w）
// ---------------------------------------------------------------------------
const UP = "ABCDEFGHJKLMNPQRSTUVWXYZ", LO = "abcdefghijkmnpqrstuvwxyz", DG = "23456789";
export const TEMP_ALPHABET = UP + LO + DG;
/** 0..n-1 の一様な乱数（偏りが出ないよう棄却法）。テストで差し替えられる */
export type RandomBytes = (n: number) => Uint8Array;
const cryptoBytes: RandomBytes = n => { const a = new Uint8Array(n); globalThis.crypto.getRandomValues(a); return a; };
function pick(n: number, rnd: RandomBytes): number {
  const lim = 256 - (256 % n);
  for (;;) { for (const b of rnd(16)) if (b < lim) return b % n; }
}
export function generateTempPassword(rnd: RandomBytes = cryptoBytes): string {
  for (;;) {
    const cs = Array.from({ length: 12 }, () => TEMP_ALPHABET[pick(TEMP_ALPHABET.length, rnd)]);
    const s = cs.join("");
    if (/[A-Z]/.test(s) && /[a-z]/.test(s) && /[2-9]/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8)}`;
  }
}
/** 仮パスワードの強さ（ビット）。12文字×log2(56) ≒ 69.7 */
export const TEMP_PASSWORD_BITS = 12 * Math.log2(TEMP_ALPHABET.length);

// ---------------------------------------------------------------------------
// 入力チェック
// ---------------------------------------------------------------------------
export const normalizeEmail = (s: string) => s.trim().toLowerCase();
export const isValidEmail = (s: string) => /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(s) && s.length <= 254;
const WEAK = [
  "password", "passw0rd", "p@ssword", "1234567890", "12345678910", "0123456789", "123456789", "987654321", "qwertyuiop", "qwerty", "asdfghjkl", "asdfgh", "zxcvbnm",
  "abcdefghij", "abc123", "iloveyou", "letmein", "welcome", "admin", "monkey", "dragon", "sunshine", "princess", "baseball", "football", "master", "superman",
  "kokage", "salon", "laciel", "flear", "matsuge", "eyelash", "headspa", "hakozaki", "ohashi", "gotanda", "fukuoka",
];
/** 全体が「短いかたまりの繰り返し」（abcabcabc・121212…）か */
const isRepeat = (s: string) => { for (let n = 1; n <= 3; n++) if (s.length >= n * 3 && s === s.slice(0, n).repeat(Math.ceil(s.length / n)).slice(0, s.length)) return true; return false; };
/** 全体が1つずつ増える／減る並び（abcdefghij・9876543210） */
const isRun = (s: string) => { if (s.length < 4) return false; const d = s.charCodeAt(1) - s.charCodeAt(0); if (Math.abs(d) !== 1) return false; for (let i = 2; i < s.length; i++) if (s.charCodeAt(i) - s.charCodeAt(i - 1) !== d) return false; return true; };
/** メールの @ の前（＋や . で区切った各部分も）。4文字以上のものだけ */
export function emailWords(email?: string | null): string[] {
  const local = (email || "").split("@")[0]?.toLowerCase() || "";
  return [...new Set([local, ...local.split(/[+._-]/)].filter(w => w.length >= 4))];
}
/** 自分で決めるパスワード・オーナーが決めるパスワードのチェック（null＝OK） */
export function checkNewPassword(pw: string, email?: string | null): string | null {
  if (pw.length < MIN_PASSWORD) return `パスワードは${MIN_PASSWORD}文字以上にしてください`;
  if (pw.length > 72) return "パスワードは72文字までにしてください";
  if (/\s/.test(pw)) return "空白（スペース）は入れないでください";
  if (/^(.)\1+$/.test(pw)) return "同じ文字だけのパスワードは使えません";
  const low = pw.toLowerCase();
  if (isRepeat(low) || isRun(low)) return "「abcabc…」「12345…」のような並びは使えません";
  const core = low.replace(/[^a-z]/g, "");   // 数字・記号を足しただけ（kokage2026! など）も弱い
  if (WEAK.some(w => (low.includes(w) && low.length - w.length <= 4) || core === w)) return "よく使われる言葉に近いパスワードは使えません";
  if (/^\d+$/.test(pw) && new Set(pw).size <= 3) return "数字の繰り返しは使えません";
  if (emailWords(email).some(w => low.includes(w))) return "メールアドレスと同じ言葉は入れないでください";
  return null;
}
/** 強さの目安（画面の表示用）。0＝使えない 1＝弱め 2＝ふつう 3＝強い */
export function passwordStrength(pw: string, email?: string | null): { level: 0 | 1 | 2 | 3; label: string; hint: string } {
  if (!pw) return { level: 0, label: "", hint: `${MIN_PASSWORD}文字以上。英字・数字・記号をまぜると強くなります` };
  const bad = checkNewPassword(pw, email);
  if (bad) return { level: 0, label: "使えません", hint: bad };
  const kinds = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter(r => r.test(pw)).length;
  const uniq = new Set(pw).size;
  const score = (pw.length >= 14 ? 2 : pw.length >= 12 ? 1 : 0) + (kinds >= 3 ? 2 : kinds === 2 ? 1 : 0) + (uniq >= 8 ? 1 : 0);
  if (score >= 4) return { level: 3, label: "強い", hint: "とても良いです" };
  if (score >= 2) return { level: 2, label: "ふつう", hint: "使えます。もう少し長くするか、記号・数字をまぜるとより安心です" };
  return { level: 1, label: "弱め", hint: "使えますが、12文字以上にして英字・数字・記号をまぜるのがおすすめです" };
}
/** お店の Gmail から「お店のGmail＋名前」のアドレスを作る（本人のメールが無いスタッフ用）。Gmail でなければ null */
export function plusAddress(storeEmail: string | null | undefined, nameEn: string | null | undefined, fallbackNo = 1): string | null {
  const m = (storeEmail || "").trim().toLowerCase().match(/^([^@+\s]+)(?:\+[^@]*)?@(gmail\.com|googlemail\.com)$/);
  if (!m) return null;
  const tag = (nameEn || "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]/g, "").slice(0, 20) || `staff${fallbackNo}`;
  return `${m[1]}+${tag}@${m[2]}`;
}

// ---------------------------------------------------------------------------
// 状態の判定
// ---------------------------------------------------------------------------
export interface AuthInfo { id: string; email?: string | null; last_sign_in_at?: string | null; banned_until?: string | null; must_change?: boolean | null }
export function loginStatusOf(u: AuthInfo | null | undefined, now = Date.now()): LoginStatus {
  if (!u) return "none";
  if (u.banned_until && new Date(u.banned_until).getTime() > now) return "stopped";
  if (u.must_change || !u.last_sign_in_at) return "invited";
  return "active";
}

// ---------------------------------------------------------------------------
// 権限：誰が誰に何をできるか（サーバでも同じ関数で確かめる）
//  ・発行・招待・パスワード再設定・再開：オーナーだけ
//  ・止める：オーナー・店長（店長はオーナーを止められない）
//  ・自分のログインはここでは変えられない（自分を締め出さないように）
//  ・退職した人には、発行・再設定・再開はできない（先に在籍に戻す）
//  ・設定＞ユーザー（ユーザーの追加・オーナーが決めたパスワードへの変更）：オーナーだけ。オーナーは作れない・変えられない
// ---------------------------------------------------------------------------
export interface LoginActor { staff_id?: string | null; auth_user_id?: string | null; role: StaffRole | null | undefined }
export interface LoginTarget { id: string; role: StaffRole; active?: boolean | null; auth_user_id?: string | null }
export function canSeeLoginStatus(role: StaffRole | null | undefined) { return role === "owner" || role === "manager"; }
export function loginPermissionError(kind: StaffLoginKind, actor: LoginActor, target: LoginTarget): string | null {
  const role = actor.role;
  if (role !== "owner" && role !== "manager") return "この操作はオーナー・店長だけができます";
  const self = (!!actor.staff_id && actor.staff_id === target.id) || (!!actor.auth_user_id && actor.auth_user_id === target.auth_user_id);
  if (self) return "自分のログインはここでは変えられません";
  if (kind === "stop") {
    if (target.role === "owner" && role !== "owner") return "オーナーのログインを止められるのはオーナーだけです";
    return null;
  }
  if (kind === "create_user" || kind === "set_password") {
    if (role !== "owner") return "ユーザーの追加・パスワードの変更はオーナーだけができます";
    if (target.role === "owner") return "オーナーのログインはここでは変えられません";
  }
  if (role !== "owner") return kind === "resume" ? "ログインの再開はオーナーだけができます" : "ログインの発行・パスワードの再設定はオーナーだけができます";
  if (target.active === false) return "退職した人にはできません（先に「在籍」に戻してください）";
  return null;
}
