// 経理日別売上集計の Excel（.xlsx）。サロンアンサーの見本（経理日別売上集計_サロンアンサー見本_大橋2026-11.xlsx）と
// 同じ列の幅・行の高さ・セルの結合・色・罫線・並びで作る。exceljs は重いので、押したときだけ読み込む。
import type { Workbook, Worksheet, Borders, Fill } from "exceljs";
import { PAY_COLS, type AcctReport, type PayCol } from "@/lib/accounting";

// 見本の列の幅（A〜AR）
const WIDTHS: [string, number][] = [["A", 3.3], ["B", 6.7], ["C", 3.3], ["D", 3.0], ["E", 6.3], ["F", 4.0], ["G", 2.3], ["H", 6.0], ["I", 0.3], ["J", 1.3], ["K", 1.7], ["L", 3.3], ["M", 5.0], ["N", 1.3], ["O", 0.3], ["P", 5.0], ["Q", 1.0], ["R", 6.3], ["S", 1.0], ["T", 5.0], ["U", 0.3], ["V", 3.0], ["W", 0.5], ["X", 1.2], ["Y", 1.7], ["Z", 5.5], ["AA", 0.8], ["AB", 0.3], ["AC", 6.0], ["AD", 6.3], ["AE", 2.7], ["AF", 3.7], ["AG", 4.7], ["AH", 1.7], ["AI", 6.3], ["AJ", 2.0], ["AK", 3.3], ["AL", 1.0], ["AM", 6.3], ["AN", 4.3], ["AO", 2.0], ["AP", 6.3], ["AQ", 0.3], ["AR", 3.3]];
const COLS = WIDTHS.map(w => w[0]);
const ci = (c: string) => COLS.indexOf(c) + 1;
const between = (a: string, b: string) => COLS.slice(ci(a) - 1, ci(b));

// 日別の表：1つの値が入るセルの範囲（見本と同じ結合）
const DAY_CELLS: [string, string][] = [
  ["B", "B"],                                        // 日付
  ["C", "D"], ["E", "E"], ["F", "G"],                // 売上合計 税抜・消費税・税込
  ["H", "I"], ["J", "L"], ["M", "N"],                // 技術売上
  ["O", "Q"], ["R", "R"], ["S", "U"],                // 会員カード売上
  ["V", "Y"], ["Z", "AA"], ["AB", "AC"],             // 店販売上
  ["AD", "AD"], ["AE", "AF"], ["AG", "AH"], ["AI", "AI"], ["AJ", "AL"], ["AM", "AM"], ["AN", "AO"], ["AP", "AP"],   // 売上入金 8列
];
const HEAD_GROUPS: { from: string; to: string; label: string }[] = [
  { from: "C", to: "G", label: "売上合計" }, { from: "H", to: "N", label: "技術売上" }, { from: "O", to: "U", label: "会員カード売上" }, { from: "V", to: "AC", label: "店販売上" }, { from: "AD", to: "AP", label: "売上入金" },
];
const SUB_LABELS = ["税抜", "消費税", "税込", "税抜", "消費税", "税込", "税抜", "消費税", "税込", "税抜", "消費税", "税込", "現金", "クレジット", "電子マネー", "売掛金", "前受出金", "商品券", "ポイント利用", "その他"];

const FONT = "ＭＳ Ｐゴシック";
const GREEN = "FFCCFFCF", BLUE = "FFC5D9F1";
const thin = { style: "thin" as const, color: { argb: "FF000000" } };
const fill = (argb: string): Fill => ({ type: "pattern", pattern: "solid", fgColor: { argb } });
const YEN = '"¥"#,##0', NUM = "#,##0", PPL = '#,##0"人"';

export interface XlsxTitle { period: string; store: string; createdAt?: Date }

/** ブラウザ・Node の両方で使える（Node ではテスト・見本の書き出しに使う） */
export async function buildAccountingWorkbook(rep: AcctReport, t: XlsxTitle): Promise<Workbook> {
  const mod = await import("exceljs");
  const ExcelJS = (mod as unknown as { default?: typeof import("exceljs") }).default ?? mod;
  const wb = new ExcelJS.Workbook();
  wb.creator = "salon-app"; wb.created = t.createdAt ?? new Date();
  const ws = wb.addWorksheet("経理日別売上集計", {
    pageSetup: { paperSize: 9, orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 1, margins: { left: 0.2, right: 0.2, top: 0.3, bottom: 0.3, header: 0, footer: 0 } },
    views: [{ showGridLines: false, zoomScale: 160 }],
  });
  WIDTHS.forEach(([c, w]) => { ws.getColumn(c).width = w; });
  const base = { name: FONT, size: 6 };
  const put = (addr: string, v: string | number | Date | null, o: { fmt?: string; h?: "left" | "right" | "center"; size?: number; bold?: boolean } = {}) => {
    const c = ws.getCell(addr); c.value = v; c.font = { ...base, size: o.size ?? 6, bold: !!o.bold };
    c.alignment = { horizontal: o.h ?? "left", vertical: "middle" }; if (o.fmt) c.numFmt = o.fmt;
  };
  const merge = (a: string, b: string) => { if (a !== b) ws.mergeCells(`${a}:${b}`); };
  const border = (r: number, cols: string[], b: Partial<Borders>) => cols.forEach(c => { const cell = ws.getCell(`${c}${r}`); cell.border = { ...cell.border, ...b }; });

  // ---- 見出し ----
  ws.getRow(1).height = 20; ws.getRow(2).height = 30;
  merge("B2", "AQ2"); put("B2", "経理日別売上集計", { h: "center", size: 13, bold: true });
  merge("B3", "O3"); put("B3", `処理年月日：${t.period}`);
  merge("B4", "T4"); put("B4", `店舗名：${t.store}`);
  for (let r = 3; r <= 10; r++) ws.getRow(r).height = 10;
  ws.getRow(11).height = 6; ws.getRow(12).height = 4; ws.getRow(13).height = 10; ws.getRow(14).height = 10;

  // ---- 上の4つの箱（総売上・売上入金・売掛入金・前受入金） ----
  const s = rep.summary;
  type Line = { label: string; amount: number | null; count: number | null } | null;
  const box1: Line[] = [
    { label: "・総売上", amount: s.total.amount, count: s.total.count }, { label: "技術売上", amount: s.tech.amount, count: s.tech.count },
    { label: "会員C売上", amount: s.member.amount, count: s.member.count }, { label: "店販売上", amount: s.product.amount, count: s.product.count },
    { label: "・消費税", amount: s.tax.amount, count: s.tax.count }, { label: "技術消費税", amount: s.taxTech.amount, count: s.taxTech.count },
    { label: "会員C消費税", amount: s.taxMember.amount, count: s.taxMember.count }, { label: "店販消費税", amount: s.taxProduct.amount, count: s.taxProduct.count },
    { label: "（内　軽減税率　", amount: s.reducedTax, count: null },
  ];
  const payOrder: PayCol[] = ["cash", "credit", "emoney", "ar", "prepaid", "voucher", "point", "other"];
  const payLabel: Record<PayCol, string> = { cash: "現金", credit: "クレジット", emoney: "電子マネー", ar: "売掛金", prepaid: "前受出金", voucher: "商品券", point: "ポイント利用", other: "その他" };
  const box2: Line[] = [{ label: "・売上入金", amount: s.payTotal.amount, count: s.payTotal.count }, ...payOrder.map(c => ({ label: payLabel[c], amount: s.pay[c].amount, count: s.pay[c].count }))];
  const zeroBox = (title: string): Line[] => [{ label: title, amount: 0, count: 0 }, ...["現金", "クレジット", "電子マネー", "商品券", "その他"].map(l => ({ label: l, amount: 0, count: 0 }))];
  const box3 = zeroBox("・売掛入金"), box4 = zeroBox("・前受入金");
  // 箱1・2は 5〜10・11(+12)・13・14 行、箱3・4は 5〜10 行
  const rowsOf = [5, 6, 7, 8, 9, 10, 11, 13, 14];
  const boxes: { lines: Line[]; label: [string, string]; amount: [string, string]; count: [string, string] }[] = [
    { lines: box1, label: ["B", "C"], amount: ["D", "F"], count: ["G", "J"] },
    { lines: box2, label: ["L", "M"], amount: ["N", "S"], count: ["T", "V"] },
    { lines: box3, label: ["Y", "AB"], amount: ["AC", "AE"], count: ["AF", "AG"] },
    { lines: box4, label: ["AI", "AJ"], amount: ["AK", "AN"], count: ["AO", "AP"] },
  ];
  for (const bx of boxes) bx.lines.forEach((ln, i) => {
    if (!ln) return; const r = rowsOf[i]; const r2 = r === 11 ? 12 : r;
    ws.mergeCells(`${bx.label[0]}${r}:${bx.label[1]}${r2}`); put(`${bx.label[0]}${r}`, ln.label);
    ws.mergeCells(`${bx.amount[0]}${r}:${bx.amount[1]}${r2}`); put(`${bx.amount[0]}${r}`, ln.amount, { fmt: YEN, h: "right" });
    ws.mergeCells(`${bx.count[0]}${r}:${bx.count[1]}${r2}`);
    if (ln.count !== null) put(`${bx.count[0]}${r}`, ln.count, { fmt: PPL, h: "right" }); else put(`${bx.count[0]}${r}`, "）", { h: "left" });
  });
  border(5, between("B", "AP"), { top: thin });
  for (let r = 5; r <= 14; r++) { border(r, ["B"], { left: thin }); border(r, ["AP"], { right: thin }); }

  // ---- 日別の表：見出し（15・16行） ----
  ws.getRow(15).height = 10; ws.getRow(16).height = 10;
  ws.mergeCells("B15:B16"); put("B15", "日付", { h: "center" });
  for (const g of HEAD_GROUPS) { ws.mergeCells(`${g.from}15:${g.to}15`); put(`${g.from}15`, g.label, { h: "center" }); }
  DAY_CELLS.slice(1).forEach(([a, b], i) => { merge(`${a}16`, `${b}16`); put(`${a}16`, SUB_LABELS[i], { h: "center" }); });
  for (const r of [15, 16]) for (const [a] of DAY_CELLS) { const c = ws.getCell(`${a}${r}`); c.fill = fill(GREEN); }
  for (const g of HEAD_GROUPS) ws.getCell(`${g.from}15`).fill = fill(GREEN);
  border(15, between("B", "AP"), { top: thin }); border(16, between("C", "AP"), { top: thin });
  for (const r of [15, 16]) { DAY_CELLS.forEach(([a]) => border(r, [a], { left: thin })); border(r, ["AP"], { right: thin }); }

  // ---- 日別の表：本体 ----
  let r = 17;
  const last = 16 + rep.rows.length;
  for (const row of rep.rows) {
    ws.getRow(r).height = 10;
    const vals: (string | number)[] = [row.label,
      row.total.net, row.total.tax, row.total.gross, row.tech.net, row.tech.tax, row.tech.gross,
      row.member.net, row.member.tax, row.member.gross, row.product.net, row.product.tax, row.product.gross,
      ...PAY_COLS.map(c => row.pay[c])];
    const strong = row.kind !== "day";
    DAY_CELLS.forEach(([a, b], i) => {
      merge(`${a}${r}`, `${b}${r}`);
      if (i === 0) put(`${a}${r}`, vals[0], { h: strong ? "right" : "center" }); else put(`${a}${r}`, vals[i], { fmt: NUM, h: "right" });
      if (strong) ws.getCell(`${a}${r}`).fill = fill(BLUE);
      border(r, [a], { left: thin });
    });
    border(r, between("B", "AP"), { top: thin }); border(r, ["AP"], { right: thin });
    if (r === last) border(r, between("B", "AP"), { bottom: thin });
    r++;
  }

  // ---- 下の余白と作成日時・ページ ----
  ws.getRow(r).height = 45; r++;
  ws.getRow(r).height = 10;
  ws.mergeCells(`B${r}:H${r}`); put(`B${r}`, t.createdAt ?? new Date(), { fmt: "yyyy/mm/dd hh:mm:ss" });
  ws.mergeCells(`Q${r}:V${r}`); put(`Q${r}`, "1  /  ", { h: "right" });
  ws.mergeCells(`X${r}:Z${r}`); put(`X${r}`, 1);
  ws.getRow(r + 1).height = 20;
  ws.pageSetup.printArea = `A1:AR${r + 1}`;
  return wb;
}

/** ブラウザでダウンロード */
export async function downloadAccountingXlsx(rep: AcctReport, t: XlsxTitle, fileName: string) {
  const wb = await buildAccountingWorkbook(rep, t);
  const buf = await wb.xlsx.writeBuffer();
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
  a.download = fileName; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

export type { Worksheet };
