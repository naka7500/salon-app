// HPB予約メールの「送り主の確認」（監査 2026-11-08 S2）。
// 転送スクリプト（tools/gas/hpb_forwarder.gs）が送ってくる From と、Gmail が付けた認証結果（Authentication-Results）を見て、
// HPB（サロンボード）から本当に届いたメールだけを通す。通さないメールは受信ログに「拒否」で残す（本文・名前・電話は残さない）。
//
// 判定
//  1) From のドメインが、店ごとの「送り主の許可リスト」（設定＞HPB連携。空なら下の既定）に入っていること（サブドメインも可）
//  2) 認証結果があるときは、Gmail（mx.google.com）が付けたもので、
//       DKIM が pass かつ 署名ドメイン（header.d / header.i）が From のドメインと揃っていて許可リストの中
//       または SPF が pass かつ 封筒の送り主（smtp.mailfrom）のドメインが許可リストの中
//     のどちらかを満たし、DMARC が fail でないこと
//  3) 認証結果が無いとき（古い転送スクリプト）は、店の設定「認証結果の無いメールは受け付けない」（既定オン）なら拒否

/** 既定の送り主ドメイン（要確認：本物のHPBの通知メールの From で確かめて、設定＞HPB連携で直す） */
export const DEFAULT_HPB_FROM_DOMAINS = ["salonboard.com", "beauty.hotpepper.jp"];

const DOMAIN_RE = /^(?=.{3,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** 設定画面の入力（改行・カンマ・空白区切り）→ ドメインの配列。@ や from: が付いていても外す。正しくないものは捨てる */
export function parseDomainList(s: string | string[] | null | undefined): string[] {
  const raw = Array.isArray(s) ? s : String(s ?? "").split(/[\s,、]+/);
  const out: string[] = [];
  for (const x of raw) {
    const d = String(x).trim().toLowerCase().replace(/^from:/, "").replace(/^.*@/, "").replace(/^\.+|\.+$/g, "");
    if (d && DOMAIN_RE.test(d) && !out.includes(d)) out.push(d);
  }
  return out.slice(0, 10);
}

export function effectiveDomains(list: string[] | null | undefined): string[] {
  const d = parseDomainList(list ?? []);
  return d.length ? d : DEFAULT_HPB_FROM_DOMAINS;
}

/** "SALON BOARD <yoyaku@salonboard.com>" → "yoyaku@salonboard.com"（取れなければ null） */
export function fromAddress(from: string | null | undefined): string | null {
  const s = String(from ?? "").trim().slice(0, 500);
  if (!s) return null;
  const angle = s.match(/<\s*([^<>\s]+@[^<>\s]+)\s*>\s*$/);
  const a = (angle ? angle[1] : s).trim().toLowerCase();
  if (/[\s,;<>"]/.test(a)) return null;
  const m = a.match(/^[^@]+@([^@]+)$/);
  return m && DOMAIN_RE.test(m[1]) ? a : null;
}
export const domainOf = (addr: string | null) => (addr ? addr.slice(addr.lastIndexOf("@") + 1) : null);

/** d が許可リストのどれか（またはそのサブドメイン）か */
export function domainAllowed(d: string | null | undefined, allowed: string[]) {
  const x = String(d ?? "").toLowerCase().replace(/\.$/, "");
  return !!x && allowed.some(a => x === a || x.endsWith("." + a));
}
/** DKIM の署名ドメインと From のドメインが揃っているか（どちらかがもう一方のサブドメインでもよい） */
const aligned = (a: string, b: string) => a === b || a.endsWith("." + b) || b.endsWith("." + a);

export interface AuthSummary { authserv: string | null; dkimPass: string[]; spf: string | null; spfDomain: string | null; dmarc: string | null }
/** Authentication-Results の値を読む（Gmail の形：mx.google.com; dkim=pass header.i=@x.com …; spf=pass (…) smtp.mailfrom=…; dmarc=pass …） */
export function parseAuthResults(h: string | null | undefined): AuthSummary | null {
  const s = String(h ?? "").replace(/\r?\n[ \t]+/g, " ").replace(/^authentication-results:\s*/i, "").trim().slice(0, 4000);
  if (!s) return null;
  const parts = s.split(";").map(x => x.trim()).filter(Boolean);
  const authserv = (parts[0] || "").split(/\s+/)[0]?.toLowerCase() || null;
  const out: AuthSummary = { authserv, dkimPass: [], spf: null, spfDomain: null, dmarc: null };
  for (const p of parts.slice(1)) {
    const clean = p.replace(/\([^)]*\)/g, " ");
    const m = clean.match(/^\s*(dkim|spf|dmarc)\s*=\s*([a-z]+)/i);
    if (!m) continue;
    const method = m[1].toLowerCase(), result = m[2].toLowerCase();
    if (method === "dkim" && result === "pass") {
      const d = clean.match(/header\.d\s*=\s*([^\s;]+)/i)?.[1] ?? clean.match(/header\.i\s*=\s*([^\s;]+)/i)?.[1]?.replace(/^.*@/, "");
      if (d) out.dkimPass.push(d.toLowerCase().replace(/\.$/, ""));
    } else if (method === "spf" && out.spf === null) {
      out.spf = result;
      const mf = clean.match(/smtp\.mailfrom\s*=\s*([^\s;]+)/i)?.[1];
      out.spfDomain = mf ? mf.toLowerCase().replace(/^.*@/, "").replace(/\.$/, "") : null;
    } else if (method === "dmarc" && out.dmarc === null) out.dmarc = result;
  }
  return out;
}

export interface SenderInput { from?: string | null; authResults?: string | null }
export interface SenderOptions { allowedDomains?: string[] | null; requireAuth?: boolean | null }
export interface SenderVerdict { ok: boolean; reason: string | null; fromDomain: string | null; authChecked: boolean }

/** 送り主の確認。ok=false のときの reason は日本語（個人情報は入れない） */
export function checkSender(input: SenderInput, opt: SenderOptions = {}): SenderVerdict {
  const allowed = effectiveDomains(opt.allowedDomains);
  const addr = fromAddress(input.from);
  const fromDomain = domainOf(addr);
  const no = (reason: string, authChecked = false): SenderVerdict => ({ ok: false, reason, fromDomain, authChecked });
  if (!fromDomain) return no("送り主（From）が読めないため拒否しました");
  if (!domainAllowed(fromDomain, allowed)) return no(`送り主のドメイン（${fromDomain}）が許可リストにないため拒否しました`);
  const raw = String(input.authResults ?? "").trim();
  if (!raw) {
    if (opt.requireAuth === false) return { ok: true, reason: null, fromDomain, authChecked: false };
    return no("送信元の認証結果（DKIM/SPF）が付いていないため拒否しました（転送スクリプトを新しい版に入れ替えてください）");
  }
  const a = parseAuthResults(raw);
  if (!a || a.authserv !== "mx.google.com") return no("Gmail が付けた認証結果ではないため拒否しました", true);
  if (a.dmarc === "fail") return no("DMARC が fail のため拒否しました（なりすましの疑い）", true);
  const dkimOk = a.dkimPass.some(d => d.includes(".") && aligned(d, fromDomain) && domainAllowed(d, allowed));
  const spfOk = a.spf === "pass" && domainAllowed(a.spfDomain, allowed);
  if (!dkimOk && !spfOk) return no("DKIM・SPF のどちらも pass ではない（または送り主と合わない）ため拒否しました", true);
  return { ok: true, reason: null, fromDomain, authChecked: true };
}

/** 推測しにくい受信アドレス（kokage.corp+hpb-<ランダム>@gmail.com）。base は「+」の前（例 kokage.corp@gmail.com） */
export function randomPlusAddress(base = "kokage.corp@gmail.com", rand: (n: number) => Uint8Array = n => { const a = new Uint8Array(n); globalThis.crypto.getRandomValues(a); return a; }) {
  const [local, domain] = base.split("@");
  const abc = "abcdefghijkmnpqrstuvwxyz23456789";   // 見間違えやすい l・o・0・1 は使わない
  const token = [...rand(12)].map(b => abc[b % abc.length]).join("");
  return `${local.split("+")[0]}+hpb-${token}@${domain}`;
}
/** 店のURL名から作った昔の形（kokage.corp+hpb-<slug>@gmail.com）か＝推測されやすい */
export function isGuessablePlusAddress(addr: string | null | undefined, slug: string | null | undefined) {
  const a = String(addr ?? "").toLowerCase();
  if (!a) return false;
  const tag = a.match(/\+hpb-([^@]+)@/)?.[1];
  if (!tag) return true;   // 「+hpb-」が無い＝店ごとに分かれていない
  return (!!slug && tag === String(slug).toLowerCase()) || tag.length < 10;
}
