// 会計の計算（画面・デモ・サーバ（create_sale）で同じ決まり）。画面に依存しない純粋な関数だけ（単体テストあり）。
//  - ペア（2名様）の明細：pairLines
//  - 入力チェック：validateSale（数量・値引・支払。現金以外は合計まで、お釣りは現金だけ）
//  - 消費税：saleTax（経理日別売上集計の slipBreakdown と同じ＝区分×税率ごとに内税を四捨五入。値引は技術から）
import type { Booking, Menu, NewSaleInput, PayMethod, Staff } from "@/lib/db/types";
import { PAIR_SPLIT } from "@/lib/web";
import { innerTax } from "@/lib/accounting";

export type SaleLineInput = NewSaleInput["lines"][number];

/** ペアの中での順番：お客様の付いている行が先、あとは ID 順（誰が開いても同じ順番になる） */
export function pairOrder<T extends Pick<Booking, "id" | "customer_id">>(rows: T[]): T[] {
  return [...rows].sort((a, b) => (a.customer_id ? 0 : 1) - (b.customer_id ? 0 : 1) || a.id.localeCompare(b.id));
}

/** 1組の料金を人数で分けたときの、その人の分（1人目は切り上げ、残りが2人目） */
export function pairShare(price: number, index: number, people = 2) {
  if (people <= 1) return price;
  const first = Math.ceil(price * PAIR_SPLIT);
  return index === 0 ? first : price - first;
}

/**
 * 予約から明細を作る。
 *  group：同じ pair_group の予約（キャンセル以外。この予約 b を含む。会計済みの行も含める）
 *  mode：'one'＝まだ会計していない全員を1枚に／'split'＝この予約の人の分だけ
 *  ・ペア用メニュー（people>1）の技術：1組の料金を人ごとに分けた行（2人目は残りの額）
 *  ・1名用メニューの技術：人数分（行ごと）に入れる（HPBの「2名」を1名用メニューで取り込んだときなど）
 *  ・オプション・指名料：その人の行ごと
 */
export function pairLines(b: Booking, group: Booking[], mode: "one" | "split", menus: Menu[], staffList: Pick<Staff, "id" | "name">[]): SaleLineInput[] {
  const all = pairOrder(group.some(x => x.id === b.id) ? group : [b, ...group]).filter(x => x.status !== "cancelled");
  const isPair = !!b.pair_group && all.length > 1;
  const unpaid = all.filter(x => x.id === b.id || x.status !== "done");
  const rows = mode === "one" && isPair ? [b, ...unpaid.filter(x => x.id !== b.id)] : [b];
  const out: SaleLineInput[] = [];
  const nameOf = (id?: string | null) => staffList.find(x => x.id === id)?.name || "担当なし";
  for (const row of rows) {
    const idx = all.findIndex(x => x.id === row.id);
    for (const id of row.menu_ids) {
      const mm = menus.find(x => x.id === id); if (!mm) continue;
      const pairMenu = isPair && mm.category === "technical" && (mm.people ?? 1) > 1;
      if (pairMenu) {
        out.push({ kind: "menu", menu_id: mm.id, product_id: null, name: `${mm.name}（ペア・${nameOf(row.staff_id)}分）`, unit_price: pairShare(mm.price, idx, Math.min(all.length, mm.people ?? 2)), qty: 1, tax_rate: mm.tax_rate, staff_id: row.staff_id ?? null });
      } else {
        out.push({ kind: mm.category === "option" ? "option" : "menu", menu_id: mm.id, product_id: null, name: rows.length > 1 ? `${mm.name}（${nameOf(row.staff_id)}）` : mm.name, unit_price: mm.price, qty: 1, tax_rate: mm.tax_rate, staff_id: row.staff_id ?? null });
      }
    }
  }
  return out;
}

/** ペアの相手がもう会計済みなら「この方の分だけ」しか選べない */
export function pairModeChoices(b: Booking, group: Booking[]) {
  const others = group.filter(x => x.id !== b.id && x.status !== "cancelled");
  return { isPair: !!b.pair_group && others.length > 0, othersPaid: others.filter(x => x.status === "done").length, othersUnpaid: others.filter(x => x.status !== "done") };
}

const rateOf = (r: number | string | null | undefined) => { const n = Number(r ?? 0.1); return n > 1 ? n / 100 : n; };

/** 伝票の消費税（内税）。経理日別売上集計（slipBreakdown）と同じ計算 */
export function saleTax(lines: Pick<SaleLineInput, "kind" | "unit_price" | "qty" | "tax_rate">[], discount: number) {
  const groups = new Map<string, { cat: "tech" | "product"; rate: number; gross: number }>();
  for (const l of lines) {
    const cat = l.kind === "product" ? "product" : "tech"; const rate = rateOf(l.tax_rate);
    const k = `${cat}|${rate}`; const g = groups.get(k) || { cat, rate, gross: 0 }; g.gross += l.unit_price * l.qty; groups.set(k, g);
  }
  let disc = discount || 0;
  const order = [...groups.values()].sort((a, b) => (a.cat === b.cat ? b.rate - a.rate : a.cat === "tech" ? -1 : 1));
  if (disc !== 0) {
    const sign = Math.sign(disc);
    for (const g of order) { if (disc === 0) break; const take = sign > 0 ? Math.min(Math.max(0, g.gross), disc) : Math.max(Math.min(0, g.gross), disc); g.gross -= take; disc -= take; }
    if (disc !== 0 && order[0]) { order[0].gross -= disc; disc = 0; }
  }
  let tax = 0; for (const g of groups.values()) tax += innerTax(g.gross, g.rate);
  return tax;
}

export function saleTotals(lines: Pick<SaleLineInput, "kind" | "unit_price" | "qty" | "tax_rate">[], discount: number) {
  const subtotal = lines.reduce((a, l) => a + l.unit_price * l.qty, 0);
  const total = subtotal - discount;
  return { subtotal, total, tax: saleTax(lines, discount) };
}

const isInt = (n: unknown) => typeof n === "number" && Number.isInteger(n);
const PAY_METHODS: PayMethod[] = ["cash", "card", "emoney", "qr", "gift", "voucher", "ota_prepaid", "other"];

/** 会計の入力チェック（画面・デモ・サーバで同じ）。問題なければ null、あれば日本語の理由 */
export function validateSale(input: Pick<NewSaleInput, "lines" | "discount" | "payments">): string | null {
  if (!input.lines.length) return "明細がありません";
  if (input.lines.length > 100) return "明細が多すぎます（100行まで）";
  for (const l of input.lines) {
    if (!isInt(l.qty) || l.qty < 1 || l.qty > 999) return `「${l.name}」の数量は1以上の整数にしてください（取消は赤伝で）`;
    if (!isInt(l.unit_price) || l.unit_price < 0) return `「${l.name}」の金額が正しくありません`;
  }
  const { subtotal, total } = saleTotals(input.lines, input.discount || 0);
  if (!isInt(input.discount) || input.discount < 0) return "値引は0円以上の整数にしてください";
  if (input.discount > subtotal) return `値引が小計（${subtotal.toLocaleString()}円）より大きくなっています`;
  if (total < 0) return "合計がマイナスになる会計はできません（取消は赤伝で）";
  let paid = 0, nonCash = 0;
  for (const p of input.payments) {
    if (!PAY_METHODS.includes(p.method)) return "支払方法が正しくありません";
    if (!isInt(p.amount) || p.amount < 0) return "支払の金額は0円以上の整数にしてください";
    paid += p.amount; if (p.method !== "cash") nonCash += p.amount;
  }
  if (nonCash > total) return `現金以外の支払（${nonCash.toLocaleString()}円）が合計（${total.toLocaleString()}円）を超えています。お釣りが出るのは現金だけです`;
  if (paid < total) return `お預かりが ${(total - paid).toLocaleString()}円 足りません`;
  return null;
}

/** 会計1回ぶんの合言葉（通信をやり直しても伝票を二重にしない） */
export const newClientKey = () => (typeof globalThis.crypto !== "undefined" && "randomUUID" in globalThis.crypto ? globalThis.crypto.randomUUID()
  : "xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx".replace(/x/g, () => Math.floor(Math.random() * 16).toString(16)));
