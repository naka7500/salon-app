import { beforeAll, describe, expect, it } from "vitest";
import type { Sale, SaleLine, Payment, PayMethod } from "@/lib/db/types";
import { accountingReport, innerTax, slipBreakdown, PAY_COLS, accountingCsvRows } from "../accounting";
import { buildAccountingWorkbook } from "../accountingXlsx";
import { ensureJst } from "../inbound/tz";

beforeAll(() => ensureJst());

let n = 0;
type L = { kind?: SaleLine["kind"]; amount: number; rate?: number };
function slip(day: string, lines: L[], pays: [PayMethod, number][], o: Partial<Sale> = {}): Sale {
  const id = `s${++n}`;
  const ls: SaleLine[] = lines.map((l, i) => ({ id: `${id}-l${i}`, sale_id: id, kind: l.kind ?? "menu", name: "x", unit_price: l.amount, qty: 1, tax_rate: l.rate ?? 0.1, amount: l.amount }));
  const subtotal = ls.reduce((a, l) => a + l.amount, 0); const discount = o.discount ?? 0; const total = subtotal - discount;
  const ps: Payment[] = pays.map(([m, a], i) => ({ id: `${id}-p${i}`, sale_id: id, method: m, amount: a }));
  return { id, store_id: "st", sale_no: id, sold_at: new Date(`${day}T14:00:00`).toISOString(), status: "confirmed", subtotal, discount, tax: 0, total, lines: ls, payments: ps, ...o };
}
function reverse(s: Sale, day: string): Sale {
  return { ...s, id: s.id + "R", status: "reversal", reverses_sale_id: s.id, sold_at: new Date(`${day}T18:00:00`).toISOString(), subtotal: -s.subtotal, discount: -s.discount, total: -s.total,
    lines: s.lines.map(l => ({ ...l, qty: -l.qty, amount: -l.amount })), payments: s.payments.map(p => ({ ...p, amount: -p.amount })) };
}

describe("消費税の丸め（サロンアンサー見本に合わせる）", () => {
  it("伝票ごとに四捨五入", () => {
    expect(innerTax(37700, 0.1)).toBe(3427);
    expect(innerTax(4290, 0.1)).toBe(390);
    expect(innerTax(-37700, 0.1)).toBe(-3427);
    expect(innerTax(1080, 0.08)).toBe(80);
  });
  it("見本 11/01：47,750 → 税抜 43,410・消費税 4,340（2伝票の四捨五入の合計）", () => {
    const r = accountingReport([slip("2026-11-01", [{ amount: 24425 }], [["card", 24425]]), slip("2026-11-01", [{ amount: 23325 }], [["emoney", 23325]])], "2026-11-01", "2026-12-01");
    const d = r.rows[0];
    expect(d.total).toEqual({ net: 43410, tax: 4340, gross: 47750 });
    expect(d.tech).toEqual({ net: 43410, tax: 4340, gross: 47750 });
  });
  it("技術と店販は別々に丸める（見本 11/05 の店販 4,290 → 税抜 3,900・消費税 390）", () => {
    const r = accountingReport([
      slip("2026-11-05", [{ amount: 12650 }], [["cash", 12650]]),                                                         // 1,150
      slip("2026-11-05", [{ amount: 13025 }], [["cash", 13025]]),                                                         // 1,184.09 → 1,184
      slip("2026-11-05", [{ amount: 13025 }, { kind: "product", amount: 4290 }], [["emoney", 16315]], { discount: 1000 }),  // 技術 12,025 → 1,093.18 → 1,093／店販 390
    ], "2026-11-01", "2026-12-01");
    const d = r.rows.find(x => x.date === "2026-11-05")!;
    expect(d.product).toEqual({ net: 3900, tax: 390, gross: 4290 });
    expect(d.tech.gross).toBe(12650 + 13025 + 12025);
    expect(d.tech.tax).toBe(1150 + 1184 + 1093);
  });
});

describe("経理日別売上集計の集計", () => {
  const sales: Sale[] = [];
  // 1か月分の伝票（毎日2〜3枚・支払方法いろいろ・店販・オプション・値引・8%・赤伝）
  const methods: PayMethod[] = ["cash", "card", "emoney", "qr", "gift", "voucher", "ota_prepaid", "other"];
  for (let d = 1; d <= 30; d++) {
    const day = `2026-11-${String(d).padStart(2, "0")}`;
    if (d % 7 === 2) continue;                                   // 定休日
    const a = slip(day, [{ amount: 7700 }, { kind: "option", amount: 1100 }], [[methods[d % 8], 8800]]);
    const b = slip(day, [{ amount: 13200 }, { kind: "product", amount: 3300 }], [["cash", 20000]], { discount: 1000 });   // お釣り 4,500
    sales.push(a, b);
    if (d % 5 === 0) sales.push(slip(day, [{ kind: "product", amount: 1080, rate: 0.08 }, { kind: "fee", amount: 550 }], [["card", 1630]]));
  }
  // 赤伝：11/03 の伝票を 11/04 に赤伝
  const o3 = sales.filter(s => new Date(s.sold_at).getDate() === 3)[0];
  o3.status = "voided"; const rv = reverse(o3, "2026-11-04"); sales.push(rv);
  // 対象外（前月・翌月）
  sales.push(slip("2026-10-31", [{ amount: 99999 }], [["cash", 99999]]), slip("2026-12-01", [{ amount: 88888 }], [["cash", 88888]]));
  const rep = accountingReport(sales, "2026-11-01", "2026-12-01");
  const inMonth = sales.filter(s => { const d = new Date(s.sold_at); return d.getMonth() === 10; });

  it("行の並び：30日＋小計3＋合計", () => {
    expect(rep.rows.length).toBe(34);
    expect(rep.rows[10].label).toBe("小計"); expect(rep.rows[21].label).toBe("小計"); expect(rep.rows[32].label).toBe("小計"); expect(rep.rows[33].label).toBe("合計");
    expect(rep.rows[0].label).toBe("11/01"); expect(rep.rows[31].label).toBe("11/30");
  });
  it("合計＝伝票の合計（税込）、税抜＋消費税＝税込", () => {
    const g = rep.rows[33];
    expect(g.total.gross).toBe(inMonth.reduce((a, s) => a + s.total, 0));
    for (const r of rep.rows) for (const k of ["total", "tech", "member", "product"] as const) expect(r[k].net + r[k].tax).toBe(r[k].gross);
    for (const r of rep.rows) { expect(r.tech.gross + r.product.gross + r.member.gross).toBe(r.total.gross); expect(r.tech.tax + r.product.tax).toBe(r.total.tax); }
  });
  it("各小計＝その区間の日の合計、合計＝小計の合計", () => {
    const days = rep.rows.filter(r => r.kind === "day"); const subs = rep.rows.filter(r => r.kind === "subtotal");
    const sum = (rs: typeof days, f: (r: (typeof days)[number]) => number) => rs.reduce((a, r) => a + f(r), 0);
    const ranges = [days.slice(0, 10), days.slice(10, 20), days.slice(20)];
    ranges.forEach((rs, i) => {
      expect(subs[i].total.gross).toBe(sum(rs, r => r.total.gross)); expect(subs[i].total.tax).toBe(sum(rs, r => r.total.tax));
      expect(subs[i].product.net).toBe(sum(rs, r => r.product.net));
      for (const c of PAY_COLS) expect(subs[i].pay[c]).toBe(sum(rs, r => r.pay[c]));
    });
    const g = rep.rows[33];
    expect(g.total.gross).toBe(sum(subs, r => r.total.gross)); expect(g.tech.net).toBe(sum(subs, r => r.tech.net));
    for (const c of PAY_COLS) expect(g.pay[c]).toBe(sum(subs, r => r.pay[c]));
  });
  it("売上入金の合計＝売上合計（お釣りを引く）、支払方法の振り分け", () => {
    for (const r of rep.rows) expect(PAY_COLS.reduce((a, c) => a + r.pay[c], 0)).toBe(r.total.gross);
    const g = rep.rows[33];
    expect(g.pay.ar).toBe(0); expect(g.pay.prepaid).toBe(0); expect(g.pay.point).toBe(0); expect(g.member.gross).toBe(0);
    expect(g.pay.voucher).toBeGreaterThan(0); expect(g.pay.other).toBeGreaterThan(0); expect(g.pay.emoney).toBeGreaterThan(0);
  });
  it("赤伝は切った日に減る（元の日はそのまま）", () => {
    const d3 = rep.rows.find(r => r.date === "2026-11-03")!; const d4 = rep.rows.find(r => r.date === "2026-11-04")!;
    const d3sales = inMonth.filter(s => new Date(s.sold_at).getDate() === 3);
    expect(d3.total.gross).toBe(d3sales.reduce((a, s) => a + s.total, 0));
    const d4sales = inMonth.filter(s => new Date(s.sold_at).getDate() === 4);
    expect(d4.total.gross).toBe(d4sales.reduce((a, s) => a + s.total, 0));
    expect(d4sales.some(s => s.status === "reversal")).toBe(true);
  });
  it("上の箱：件数・消費税の内訳・軽減税率", () => {
    const s = rep.summary;
    const live = inMonth.filter(x => x.status !== "reversal").length - inMonth.filter(x => x.status === "reversal").length;
    expect(s.total.count).toBe(live);
    expect(s.total.amount).toBe(rep.rows[33].total.gross);
    expect(s.tax.amount).toBe(s.taxTech.amount + s.taxProduct.amount);
    expect(s.reducedTax).toBe(80 * inMonth.filter(x => x.lines.some(l => l.tax_rate === 0.08)).length);
    expect(s.payTotal.amount).toBe(s.total.amount);
    expect(s.pay.cash.count).toBeGreaterThan(0);
  });
  it("値引が技術より大きいときは店販から引く", () => {
    const b = slipBreakdown(slip("2026-11-10", [{ amount: 500 }, { kind: "product", amount: 3300 }], [["cash", 2800]], { discount: 1000 }));
    expect(b.tech.gross).toBe(0); expect(b.product.gross).toBe(2800);
  });
  it("CSV と Excel が作れる（シート名・結合・数字）", async () => {
    const rows = accountingCsvRows(rep, { period: "2026/11/01 ～ 2026/11/30", store: "テスト" });
    expect(rows[0][0]).toBe("経理日別売上集計");
    const wb = await buildAccountingWorkbook(rep, { period: "2026/11/01 ～ 2026/11/30", store: "テスト", createdAt: new Date("2026-11-07T10:00:00") });
    const ws = wb.getWorksheet("経理日別売上集計")!;
    expect(ws).toBeTruthy();
    expect(ws.getCell("B2").value).toBe("経理日別売上集計");
    expect(ws.getCell("B17").value).toBe("11/01");
    expect(ws.getCell("F50").value).toBe(rep.rows[33].total.gross);
    expect(ws.getCell("B50").value).toBe("合計");
    expect(ws.getCell("D5").value).toBe(rep.summary.total.amount);
    const buf = await wb.xlsx.writeBuffer();
    expect(buf.byteLength).toBeGreaterThan(5000);
  });
});
