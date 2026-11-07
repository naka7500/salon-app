// 0020：ネット予約で既存のお客様に当たったとき、お客様の登録内容は変えず、予約した人が入れた内容を予約（web_*）に残す。
// 予約詳細で「予約時の入力が登録内容と違います」を出すための比べ方（純粋関数）。
import type { Booking, Customer } from "./db/types";

export interface WebInputDiff { field: "name" | "kana" | "phone" | "email"; label: string; typed: string; stored: string }
const LABEL: Record<WebInputDiff["field"], string> = { name: "お名前", kana: "フリガナ", phone: "電話", email: "メール" };
const normText = (s?: string | null) => (s || "").normalize("NFKC").replace(/\s+/g, "").toLowerCase();
const normPhoneDigits = (s?: string | null) => { const d = (s || "").normalize("NFKC").replace(/\D/g, ""); return d.startsWith("81") && d.length >= 11 ? `0${d.slice(2)}` : d; };

/** 予約時の入力と登録内容の違い（入力が無い項目・登録が空の項目は比べない＝空は「違う」にしない） */
export function webInputDiffs(b: Pick<Booking, "web_name" | "web_kana" | "web_phone" | "web_email">, c: Pick<Customer, "name" | "kana" | "phone" | "email"> | null | undefined): WebInputDiff[] {
  if (!c) return [];
  const out: WebInputDiff[] = [];
  const add = (field: WebInputDiff["field"], typed: string | null | undefined, stored: string | null | undefined, same: (a: string, b: string) => boolean) => {
    const t = (typed || "").trim(), s = (stored || "").trim();
    if (!t) return;
    if (!s) { if (field === "email") out.push({ field, label: LABEL[field], typed: t, stored: "（未登録）" }); return; }
    if (!same(t, s)) out.push({ field, label: LABEL[field], typed: t, stored: s });
  };
  add("name", b.web_name, c.name, (a, x) => normText(a) === normText(x));
  add("kana", b.web_kana, c.kana, (a, x) => normText(a) === normText(x));
  add("phone", b.web_phone, c.phone, (a, x) => normPhoneDigits(a) === normPhoneDigits(x));
  add("email", b.web_email, c.email, (a, x) => a.trim().toLowerCase() === x.trim().toLowerCase());
  return out;
}
