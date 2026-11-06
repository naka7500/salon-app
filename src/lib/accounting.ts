// 経理日別売上集計（サロンアンサーの「経理日別売上集計」と同じ形の表）。画面に依存しない純粋な関数だけ。
//
// 数え方（報告書にも同じことを書く）
//  - 金額は税込で入っている。1伝票ごと・区分（技術／店販）×税率ごとに「税込 × 税率 ÷ (1＋税率)」を四捨五入して消費税、税抜＝税込−消費税。
//    （サロンアンサーの見本 2026/11 大橋の数字から逆算：日の合計で切り捨て・切り上げ・四捨五入しても合わない日があり、
//      伝票ごとの四捨五入なら全部の日で合う。端数の設定はサロンアンサー側の画面で要確認）
//  - 技術売上＝メニュー・オプション・指名料など店販以外の明細−値引。店販売上＝商品の明細。値引が技術より大きいときは残りを店販から引く。
//  - 赤伝：元の伝票はその日のまま（プラス）、赤伝（マイナス伝票）は「赤伝を切った日」に入る。月をまたぐと翌月の売上が減る。
//    件数は 確定・取消済みの元伝票を＋1、赤伝を−1 で数える（同じ月なら 元＋赤伝＝0件）。
//  - 会員カード売上・売掛金・前受出金・ポイント利用・売掛入金・前受入金は、このアプリに機能が無いので 0（列は税理士さん用に残す）。
//  - 支払方法は PAY_MAP で振り分ける（無い方法は「その他」）。現金はお釣りを引いた額。
import type { Sale } from "@/lib/db/types";
import { netPayments } from "@/lib/money";

export type PayCol = "cash" | "credit" | "emoney" | "ar" | "prepaid" | "voucher" | "point" | "other";
export const PAY_COLS: PayCol[] = ["cash", "credit", "emoney", "ar", "prepaid", "voucher", "point", "other"];
export const PAY_COL_LABEL: Record<PayCol, string> = { cash: "現金", credit: "クレジット", emoney: "電子マネー", ar: "売掛金", prepaid: "前受出金", voucher: "商品券", point: "ポイント利用", other: "その他" };
/** このアプリの支払方法 → 経理の列。ここに無い方法は「その他」 */
export const PAY_MAP: Record<string, PayCol> = { cash: "cash", card: "credit", emoney: "emoney", qr: "emoney", gift: "voucher", voucher: "other", ota_prepaid: "other", other: "other" };
/** 画面に出す説明（振り分けを見えるように） */
export const PAY_MAP_NOTE: { from: string; to: PayCol; note?: string }[] = [
  { from: "現金", to: "cash", note: "お釣りを引いた額" },
  { from: "カード", to: "credit" },
  { from: "電子マネー", to: "emoney" },
  { from: "QR（PayPayなど）", to: "emoney" },
  { from: "ギフト券", to: "voucher" },
  { from: "回数券", to: "other", note: "前受金の機能が無いため" },
  { from: "OTA先払い（Klook・一休など）", to: "other", note: "税理士さんの希望で「売掛金」にも変えられます" },
  { from: "その他・上にない方法", to: "other" },
];
export const payColOf = (method: string): PayCol => PAY_MAP[method] ?? "other";

export interface Money3 { net: number; tax: number; gross: number }
export interface AcctRow {
  kind: "day" | "subtotal" | "total";
  /** 'MM/DD' または「小計」「合計」 */
  label: string;
  date?: string;
  total: Money3; tech: Money3; member: Money3; product: Money3;
  pay: Record<PayCol, number>;
}
export interface Counted { amount: number; count: number }
export interface AcctSummary {
  total: Counted; tech: Counted; member: Counted; product: Counted;
  tax: Counted; taxTech: Counted; taxMember: Counted; taxProduct: Counted;
  /** （内 軽減税率）＝8%の明細の消費税 */
  reducedTax: number;
  pay: Record<PayCol, Counted>;
  /** 売上入金の合計（件数＝伝票数） */
  payTotal: Counted;
  /** 売掛入金・前受入金（機能なし＝0） */
  arIn: Record<"total" | "cash" | "credit" | "emoney" | "voucher" | "other", Counted>;
  prepaidIn: Record<"total" | "cash" | "credit" | "emoney" | "voucher" | "other", Counted>;
}
export interface AcctReport { from: string; to: string; rows: AcctRow[]; summary: AcctSummary; slips: number }

const z3 = (): Money3 => ({ net: 0, tax: 0, gross: 0 });
const zPay = (): Record<PayCol, number> => ({ cash: 0, credit: 0, emoney: 0, ar: 0, prepaid: 0, voucher: 0, point: 0, other: 0 });
const zc = (): Counted => ({ amount: 0, count: 0 });
const add3 = (a: Money3, b: Money3) => { a.net += b.net; a.tax += b.tax; a.gross += b.gross; };
const pad = (n: number) => String(n).padStart(2, "0");
const ymdLocal = (iso: string) => { const d = new Date(iso); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const addDay = (d: string, n: number) => { const x = new Date(`${d}T00:00:00`); x.setDate(x.getDate() + n); return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`; };
/** 税率：0.1 でも 10 でも受ける */
const rateOf = (r: number | string | null | undefined) => { const n = Number(r ?? 0.1); return n > 1 ? n / 100 : n; };
/** 内税の消費税（四捨五入。マイナスは絶対値で丸めて符号を戻す） */
export const innerTax = (gross: number, rate: number) => (gross === 0 || rate <= 0 ? 0 : Math.sign(gross) * Math.round((Math.abs(gross) * rate) / (1 + rate)));

/** 1伝票の内訳：技術・店販それぞれの税込・消費税、軽減税率分の消費税、支払の振り分け */
export function slipBreakdown(s: Sale) {
  const groups = new Map<string, { cat: "tech" | "product"; rate: number; gross: number }>();
  for (const l of s.lines) {
    const cat = l.kind === "product" ? "product" : "tech"; const rate = rateOf(l.tax_rate);
    const k = `${cat}|${rate}`; const g = groups.get(k) || { cat, rate, gross: 0 }; g.gross += l.amount; groups.set(k, g);
  }
  // 値引：技術（税率の高い順）から引き、足りなければ店販から
  let disc = s.discount || 0;
  const order = [...groups.values()].sort((a, b) => (a.cat === b.cat ? b.rate - a.rate : a.cat === "tech" ? -1 : 1));
  if (disc !== 0) {
    const sign = Math.sign(disc);
    for (const g of order) { if (disc === 0) break; const take = sign > 0 ? Math.min(Math.max(0, g.gross), disc) : Math.max(Math.min(0, g.gross), disc); g.gross -= take; disc -= take; }
    if (disc !== 0) { const g = order[0] || { cat: "tech" as const, rate: 0.1, gross: 0 }; if (!order.length) groups.set("tech|0.1", g); g.gross -= disc; disc = 0; }
  }
  const tech = z3(), product = z3(); let reduced = 0;
  for (const g of groups.values()) {
    const tax = innerTax(g.gross, g.rate); const t = g.cat === "tech" ? tech : product;
    t.gross += g.gross; t.tax += tax; t.net += g.gross - tax;
    if (Math.abs(g.rate - 0.08) < 1e-9) reduced += tax;
  }
  const pay = zPay();
  for (const [m, v] of Object.entries(netPayments(s))) pay[payColOf(m)] += v;
  return { tech, product, reduced, pay };
}

/** 月（from〜to の前日まで）の経理日別売上集計。小計は10日・20日・月末の後 */
export function accountingReport(sales: Sale[], from: string, to: string): AcctReport {
  const days: string[] = []; for (let d = from; d < to; d = addDay(d, 1)) days.push(d);
  const byDay = new Map<string, AcctRow>(days.map(d => [d, { kind: "day", label: `${d.slice(5, 7)}/${d.slice(8, 10)}`, date: d, total: z3(), tech: z3(), member: z3(), product: z3(), pay: zPay() }]));
  const sm: AcctSummary = {
    total: zc(), tech: zc(), member: zc(), product: zc(), tax: zc(), taxTech: zc(), taxMember: zc(), taxProduct: zc(), reducedTax: 0,
    pay: Object.fromEntries(PAY_COLS.map(c => [c, zc()])) as Record<PayCol, Counted>, payTotal: zc(),
    arIn: { total: zc(), cash: zc(), credit: zc(), emoney: zc(), voucher: zc(), other: zc() },
    prepaidIn: { total: zc(), cash: zc(), credit: zc(), emoney: zc(), voucher: zc(), other: zc() },
  };
  let slips = 0;
  for (const s of sales) {
    const row = byDay.get(ymdLocal(s.sold_at)); if (!row) continue;
    const b = slipBreakdown(s); const sign = s.status === "reversal" ? -1 : 1; slips++;
    add3(row.tech, b.tech); add3(row.product, b.product); add3(row.total, b.tech); add3(row.total, b.product);
    for (const c of PAY_COLS) row.pay[c] += b.pay[c];
    sm.total.count += sign; sm.payTotal.count += sign;
    if (s.lines.some(l => l.kind !== "product")) sm.tech.count += sign;
    if (s.lines.some(l => l.kind === "product")) sm.product.count += sign;
    if (b.tech.tax + b.product.tax !== 0) sm.tax.count += sign;
    if (b.tech.tax !== 0) sm.taxTech.count += sign;
    if (b.product.tax !== 0) sm.taxProduct.count += sign;
    sm.reducedTax += b.reduced;
    for (const c of PAY_COLS) if (b.pay[c] !== 0) sm.pay[c].count += sign;
  }
  const rows: AcctRow[] = [];
  const blank = (kind: AcctRow["kind"], label: string): AcctRow => ({ kind, label, total: z3(), tech: z3(), member: z3(), product: z3(), pay: zPay() });
  const acc = (t: AcctRow, r: AcctRow) => { add3(t.total, r.total); add3(t.tech, r.tech); add3(t.member, r.member); add3(t.product, r.product); for (const c of PAY_COLS) t.pay[c] += r.pay[c]; };
  const grand = blank("total", "合計"); let sub = blank("subtotal", "小計");
  days.forEach((d, i) => {
    const r = byDay.get(d)!; rows.push(r); acc(sub, r); acc(grand, r);
    const dd = Number(d.slice(8, 10)); const last = i === days.length - 1;
    if (dd === 10 || dd === 20 || last) { rows.push(sub); sub = blank("subtotal", "小計"); }
  });
  rows.push(grand);
  sm.total.amount = grand.total.gross; sm.tech.amount = grand.tech.gross; sm.product.amount = grand.product.gross; sm.member.amount = 0;
  sm.tax.amount = grand.total.tax; sm.taxTech.amount = grand.tech.tax; sm.taxProduct.amount = grand.product.tax;
  for (const c of PAY_COLS) sm.pay[c].amount = grand.pay[c];
  sm.payTotal.amount = PAY_COLS.reduce((a, c) => a + grand.pay[c], 0);
  return { from, to, rows, summary: sm, slips };
}

/** 表の列（画面・CSV・Excel で共通の順番） */
export const MONEY_GROUPS: { key: "total" | "tech" | "member" | "product"; label: string }[] = [
  { key: "total", label: "売上合計" }, { key: "tech", label: "技術売上" }, { key: "member", label: "会員カード売上" }, { key: "product", label: "店販売上" },
];

/** CSV用の行（見本と同じ並び） */
export function accountingCsvRows(rep: AcctReport, title: { period: string; store: string }): (string | number)[][] {
  const s = rep.summary;
  const out: (string | number)[][] = [["経理日別売上集計"], [`処理年月日：${title.period}`], [`店舗名：${title.store}`], []];
  out.push(["・総売上", s.total.amount, s.total.count, "", "・売上入金", s.payTotal.amount, s.payTotal.count, "", "・売掛入金", 0, 0, "", "・前受入金", 0, 0]);
  const left: [string, Counted | null][] = [["技術売上", s.tech], ["会員C売上", s.member], ["店販売上", s.product], ["・消費税", s.tax], ["技術消費税", s.taxTech], ["会員C消費税", s.taxMember], ["店販消費税", s.taxProduct], ["（内　軽減税率）", { amount: s.reducedTax, count: NaN }]];
  const mid: PayCol[] = ["cash", "credit", "emoney", "ar", "prepaid", "voucher", "point", "other"];
  const right = ["現金", "クレジット", "電子マネー", "商品券", "その他"];
  for (let i = 0; i < 8; i++) {
    const [ll, lv] = left[i]; const pc = mid[i];
    out.push([ll, lv ? lv.amount : "", lv && !Number.isNaN(lv.count) ? lv.count : "", "", PAY_COL_LABEL[pc], s.pay[pc].amount, s.pay[pc].count, "",
      right[i] ?? "", right[i] ? 0 : "", right[i] ? 0 : "", "", right[i] ?? "", right[i] ? 0 : "", right[i] ? 0 : ""]);
  }
  out.push([]);
  out.push(["日付", ...MONEY_GROUPS.flatMap(g => [`${g.label}（税抜）`, `${g.label}（消費税）`, `${g.label}（税込）`]), ...PAY_COLS.map(c => `売上入金（${PAY_COL_LABEL[c]}）`)]);
  for (const r of rep.rows) out.push([r.label, ...MONEY_GROUPS.flatMap(g => [r[g.key].net, r[g.key].tax, r[g.key].gross]), ...PAY_COLS.map(c => r.pay[c])]);
  return out;
}
