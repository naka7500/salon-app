// 取り込みの項目・見出しからの自動対応・値の整え方（電話・日付・性別など）

export type CustField = "ignore" | "external_id" | "name" | "name_last" | "name_first" | "kana" | "kana_last" | "kana_first" | "phone" | "phone2" | "email"
  | "birthday" | "gender" | "postal_code" | "address" | "first_visit" | "last_visit" | "visit_count" | "staff" | "note";
export type VisitField = "ignore" | "date" | "external_id" | "phone" | "name" | "kana" | "staff" | "menu" | "amount" | "slip_no";

export const CUST_FIELDS: { key: CustField; label: string }[] = [
  { key: "ignore", label: "（取り込まない）" },
  { key: "external_id", label: "顧客番号（前のPOSのID）" },
  { key: "name", label: "氏名" }, { key: "name_last", label: "氏名（姓）" }, { key: "name_first", label: "氏名（名）" },
  { key: "kana", label: "フリガナ" }, { key: "kana_last", label: "フリガナ（セイ）" }, { key: "kana_first", label: "フリガナ（メイ）" },
  { key: "phone", label: "電話" }, { key: "phone2", label: "電話（2つ目）" }, { key: "email", label: "メール" },
  { key: "birthday", label: "生年月日" }, { key: "gender", label: "性別" }, { key: "postal_code", label: "郵便番号" }, { key: "address", label: "住所（複数の列はつなげる）" },
  { key: "first_visit", label: "初回来店日" }, { key: "last_visit", label: "最終来店日" }, { key: "visit_count", label: "来店回数" }, { key: "staff", label: "担当・指名" },
  { key: "note", label: "メモ・備考（複数の列はつなげる）" },
];
export const VISIT_FIELDS: { key: VisitField; label: string }[] = [
  { key: "ignore", label: "（取り込まない）" }, { key: "date", label: "来店日" }, { key: "external_id", label: "顧客番号" }, { key: "phone", label: "電話" },
  { key: "name", label: "氏名" }, { key: "kana", label: "フリガナ" }, { key: "staff", label: "担当" }, { key: "menu", label: "メニュー" }, { key: "amount", label: "金額" }, { key: "slip_no", label: "伝票番号" },
];

/** 見出しを比べやすく：全角→半角・空白と記号を消す・小文字 */
export const normHeader = (h: string) => h.normalize("NFKC").replace(/[\s　_\-・:：/／()（）[\]【】<>＜＞「」『』]/g, "").toLowerCase();

// 見出しの言葉 → 項目（上から順に判定。「フリガナ（姓）」が「姓」より先に当たるように並べる）
const CUST_RULES: [CustField, RegExp][] = [
  ["external_id", /^(顧客|会員|お客様|カルテ|患者)(番号|no|id|コード|cd)$|^(顧客|会員)?id$|^no$|^番号$|顧客番号|会員番号|顧客コード|顧客id|会員id/],
  ["kana_last", /(フリガナ|ふりがな|カナ|かな|よみ|ヨミ)姓$|姓(フリガナ|ふりがな|カナ|かな|よみ|ヨミ)|^セイ$|^せい$|^カナ\(?セイ\)?$/],
  ["kana_first", /(フリガナ|ふりがな|カナ|かな|よみ|ヨミ)名$|(^|[^氏前客])名(フリガナ|ふりがな|カナ|かな|よみ|ヨミ)|^メイ$|^めい$/],
  ["kana", /フリガナ|ふりがな|カナ|ｶﾅ|よみがな|ヨミガナ|^よみ$|^ヨミ$/],
  ["first_visit", /初回来店|初来店|初回日|初回利用/],
  ["last_visit", /最終来店|前回来店|最終利用|最終来店日|最近の来店/],
  ["visit_count", /来店回数|来店数|利用回数|来店人数$/],
  ["birthday", /生年月日|誕生日|birthday|生まれ/],
  ["gender", /性別|gender|^sex$/],
  ["postal_code", /郵便番号|^〒|^zip|postal/],
  ["address", /住所|都道府県|市区町村|番地|建物|address/],
  ["email", /メール|mail|e-?mail/],
  ["phone", /携帯|電話|tel|phone/],
  ["staff", /担当|指名|スタッフ|staff/],
  ["note", /メモ|備考|特記|コメント|注意事項|memo|note/],
  ["name_last", /^(氏名|お名前|名前|顧客名)?姓$|^苗字$|^姓$/],
  ["name_first", /^(氏名|お名前|名前|顧客名)?名$/],
  ["name", /氏名|お名前|名前|顧客名|お客様名|^name$/],
];
const VISIT_RULES: [VisitField, RegExp][] = [
  ["slip_no", /伝票(番号|no)|会計(番号|no)|レシート(番号|no)|^伝票$/],
  ["external_id", /(顧客|会員|お客様|カルテ)(番号|no|id|コード|cd)|^(顧客|会員)?id$/],
  ["date", /来店日|日付|利用日|施術日|会計日|売上日|処理日|^日時$|来店日時/],
  ["kana", /フリガナ|ふりがな|カナ|よみ/],
  ["name", /氏名|お名前|名前|顧客名|お客様名/],
  ["phone", /携帯|電話|tel/],
  ["staff", /担当|指名|スタッフ/],
  ["menu", /メニュー|施術内容|コース|技術|内容|品名|商品名/],
  ["amount", /金額|売上|合計|税込|料金|会計額/],
];

/** 見出しから自動で対応をつける。保存した対応（見出しの文字ごと）があればそれを優先 */
export function autoMap<F extends string>(header: string[], kind: "customers" | "visits", preset?: Record<string, string> | null): F[] {
  const rules = (kind === "customers" ? CUST_RULES : VISIT_RULES) as [string, RegExp][];
  const used = new Set<string>();
  return header.map(h => {
    if (preset && preset[h] !== undefined) { used.add(preset[h]); return preset[h] as F; }
    const n = normHeader(h);
    if (!n) return "ignore" as F;
    for (const [f, re] of rules) if (re.test(n)) {
      if (f === "phone" && used.has("phone")) { used.add("phone2"); return (kind === "customers" ? "phone2" : "ignore") as F; }
      const multi = f === "address" || f === "note";
      if (used.has(f) && !multi) continue;
      used.add(f); return f as F;
    }
    return "ignore" as F;
  });
}

// ---- 値の整え方 ----
export const nfkc = (s: string | null | undefined) => (s ?? "").normalize("NFKC").replace(/　/g, " ").trim();
/** 電話：数字だけ。+81 は 0 に */
export function phoneDigits(s: string | null | undefined) { let d = (s ?? "").normalize("NFKC").replace(/[^0-9+]/g, ""); if (d.startsWith("+81")) d = "0" + d.slice(3); else if (/^81\d{9,10}$/.test(d)) d = "0" + d.slice(2); return d.replace(/\D/g, ""); }
/** 電話の表記（数字が10〜11桁ならハイフンつきにそろえる） */
export function formatPhone(s: string) {
  const d = phoneDigits(s);
  if (/^0[789]0\d{8}$/.test(d)) return `${d.slice(0, 3)}-${d.slice(3, 7)}-${d.slice(7)}`;
  if (/^0\d{9}$/.test(d)) return d.startsWith("03") || d.startsWith("06") ? `${d.slice(0, 2)}-${d.slice(2, 6)}-${d.slice(6)}` : `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`;
  return nfkc(s);
}
/** カナ：ひらがな→カタカナ、空白を消す（突き合わせ用） */
export const kanaKey = (s: string | null | undefined) => nfkc(s).replace(/[ぁ-ゖ]/g, c => String.fromCharCode(c.charCodeAt(0) + 0x60)).replace(/\s/g, "");
export const nameKey = (s: string | null | undefined) => nfkc(s).replace(/\s/g, "");
/** 表示用のカナ（ひらがなはカタカナに・半角カナは全角に） */
export const kanaDisplay = (s: string) => nfkc(s).replace(/[ぁ-ゖ]/g, c => String.fromCharCode(c.charCodeAt(0) + 0x60)).replace(/\s+/g, " ");

const ERA: Record<string, number> = { M: 1868, T: 1912, S: 1926, H: 1989, R: 2019, 明治: 1868, 大正: 1912, 昭和: 1926, 平成: 1989, 令和: 2019 };
const pad = (n: number) => String(n).padStart(2, "0");
function okDate(y: number, m: number, d: number) {
  if (!(y >= 1900 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
  const dt = new Date(y, m - 1, d); if (dt.getMonth() !== m - 1) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}
/** 日付 → 'YYYY-MM-DD'。2024/1/5・2024-01-05・20240105・2024年1月5日・令和6年1月5日・H10.1.5・Excelのシリアル値。読めなければ null */
export function parseDate(raw: string | null | undefined): string | null {
  const s = nfkc(raw).replace(/\s+\d{1,2}:\d{2}(:\d{2})?$/, "").replace(/[（(].*?[)）]$/, "").trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})[/\-.年](\d{1,2})[/\-.月](\d{1,2})日?$/); if (m) return okDate(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{4})(\d{2})(\d{2})$/); if (m) return okDate(+m[1], +m[2], +m[3]);
  m = s.match(/^(明治|大正|昭和|平成|令和|[MTSHR])\s*(\d{1,2}|元)[/\-.年](\d{1,2})[/\-.月](\d{1,2})日?$/i);
  if (m) { const base = ERA[m[1].toUpperCase()] ?? ERA[m[1]]; const n = m[2] === "元" ? 1 : +m[2]; return okDate(base + n - 1, +m[3], +m[4]); }
  m = s.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})$/); if (m) return okDate(+m[3], +m[1], +m[2]);   // 1/5/2024（月/日/年）
  if (/^\d{5}(\.\d+)?$/.test(s)) { const n = Math.floor(Number(s)); if (n > 20000 && n < 80000) { const d = new Date(Date.UTC(1899, 11, 30) + n * 86400000); return okDate(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()); } }
  return null;
}
export function parseGender(raw: string | null | undefined): string | null {
  const s = nfkc(raw).toLowerCase(); if (!s) return null;
  if (/^(女|女性|f|female|woman|レディース)$/.test(s)) return "女性";
  if (/^(男|男性|m|male|man|メンズ)$/.test(s)) return "男性";
  if (/^(その他|other|未回答|不明|-)$/.test(s)) return null;
  return nfkc(raw);
}
/** 金額・回数：¥・カンマ・円を外して整数。読めなければ null */
export function parseIntLoose(raw: string | null | undefined): number | null {
  const s = nfkc(raw).replace(/[¥￥,円回人\s]/g, ""); if (!s) return null;
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  return Math.round(Number(s));
}
export const looksEmail = (s: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s);
