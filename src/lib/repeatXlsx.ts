// リピート率推移表の Excel（.xlsx）。サロンアンサーの見本（リピート率推移表_サロンアンサー見本_大橋2026-05.xlsx）と
// 同じ列の幅・行の高さ・セルの結合・色（見出し＝薄い緑）・罫線・数値の書式（#,##0 と #0.0%）・並びで作る。exceljs は押したときだけ読み込む。
import type { Workbook, Borders, Fill } from "exceljs";
import { CLASS_LABEL, CLASS_ORDER, ratio, type RepeatCell, type RepeatMonth } from "@/lib/repeat";

// 見本の列の幅（A〜AD）
const WIDTHS: [string, number][] = [["A", 3.33], ["B", 6.67], ["C", 6.67], ["D", 8.33], ["E", 0.83], ["F", 8.33], ["G", 0.83], ["H", 1.67], ["I", 3.17], ["J", 8.33], ["K", 0.17], ["L", 5.0], ["M", 0.5], ["N", 8.33], ["O", 5.67], ["P", 2.17], ["Q", 6.17], ["R", 2.17], ["S", 3.5], ["T", 8.33], ["U", 1.5], ["V", 4.17], ["W", 8.33], ["X", 5.67], ["Y", 3.5], ["Z", 4.83], ["AA", 5.67], ["AB", 8.33], ["AC", 5.67], ["AD", 2.5]];
// 見出し（6行目）：[開始, 終了, 見出し]
const HEAD: [string, string, string][] = [["D", "E", "来客数"], ["F", "I", "同月再来"], ["J", "M", "1カ月後再来"], ["N", "O", "2カ月後再来"], ["P", "S", "3カ月後再来"], ["T", "V", "4カ月後再来"], ["W", "X", "5カ月後再来"], ["Y", "AA", "6カ月後再来"], ["AB", "AC", "失客"]];
// 本体：来客数のセル、各欄の [人数のセル範囲, 割合のセル範囲]
const COUNT_CELL: [string, string] = ["D", "E"];
const BUCKET_CELLS: [[string, string], [string, string]][] = [
  [["F", "F"], ["G", "I"]], [["J", "J"], ["K", "M"]], [["N", "N"], ["O", "O"]], [["P", "Q"], ["R", "S"]],
  [["T", "T"], ["U", "V"]], [["W", "W"], ["X", "X"]], [["Y", "Z"], ["AA", "AA"]], [["AB", "AB"], ["AC", "AC"]],
];
const FONT = "IPAexゴシック";
const GREEN = "FFCCFFCF", WHITE = "FFFFFFFF";
const thin = { style: "thin" as const, color: { argb: "FF000000" } };
const fill = (argb: string): Fill => ({ type: "pattern", pattern: "solid", fgColor: { argb } });

export interface RepeatXlsxHead {
  /** 例：2026年05月度 ～ 2026年10月度 */ period: string; store: string; who: string;
  visitClass: string; returnMode: string; gender: string; nominate: string; rules: string; createdAt?: Date;
}

export async function buildRepeatWorkbook(table: RepeatMonth[], h: RepeatXlsxHead): Promise<Workbook> {
  const mod = await import("exceljs");
  const ExcelJS = (mod as unknown as { default?: typeof import("exceljs") }).default ?? mod;
  const wb = new ExcelJS.Workbook();
  wb.creator = "salon-app"; wb.created = h.createdAt ?? new Date();
  const ws = wb.addWorksheet("リピート率推移表", {
    pageSetup: { paperSize: 9, orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0, margins: { left: 0.2, right: 0.2, top: 0.3, bottom: 0.3, header: 0, footer: 0 } },
    views: [{ showGridLines: false }],
  });
  WIDTHS.forEach(([c, w]) => { ws.getColumn(c).width = w; });
  const put = (addr: string, v: string | number | Date | null, o: { fmt?: string; h?: "left" | "right" | "center"; size?: number; bold?: boolean; bg?: string } = {}) => {
    const c = ws.getCell(addr); c.value = v; c.font = { name: FONT, size: o.size ?? 8, bold: !!o.bold };
    c.alignment = { horizontal: o.h ?? "left", vertical: "middle" }; if (o.fmt) c.numFmt = o.fmt; c.fill = fill(o.bg ?? WHITE);
  };
  const merge = (a: string, b: string) => { if (a !== b) ws.mergeCells(`${a}:${b}`); };
  const border = (addr: string, b: Partial<Borders>) => { const c = ws.getCell(addr); c.border = { ...c.border, ...b }; };

  // ---- 見出し（2〜5行） ----
  ws.getRow(1).height = 20; ws.getRow(2).height = 30;
  merge("B2", "AC2"); put("B2", "リピート率推移表", { h: "center", size: 13, bold: true });
  merge("B3", "H3"); put("B3", `処理年月：${h.period}`);
  merge("I3", "U3"); put("I3", `店舗名：${h.store}`);
  merge("V3", "AC3"); put("V3", `担当：${h.who}`);
  merge("B4", "U4"); put("B4", "顧客リスト：指定なし");
  merge("V4", "AC4"); put("V4", h.rules, { size: 7 });
  merge("B5", "D5"); put("B5", `来店集計区分：${h.visitClass}`);
  merge("E5", "K5"); put("E5", `再来集計区分：${h.returnMode}`);
  merge("L5", "P5"); put("L5", `性別区分：${h.gender}`);
  merge("Q5", "U5"); put("Q5", `指名区分：${h.nominate}`);
  merge("V5", "Y5"); put("V5", "顧客区分：店舗");
  for (const r of [3, 4, 5]) ws.getRow(r).height = 14;

  // ---- 表の見出し（6行） ----
  ws.getRow(6).height = 16;
  merge("B6", "C6"); put("B6", null, { h: "center" }); border("B6", { bottom: thin }); border("C6", { bottom: thin });
  for (const [a, b, label] of HEAD) {
    merge(`${a}6`, `${b}6`); put(`${a}6`, label, { h: "center", bg: GREEN });
    border(`${a}6`, { left: thin, top: thin, bottom: thin });
  }
  border("AB6", { right: thin }); border("AC6", { right: thin, top: thin, bottom: thin });

  // ---- 本体（1か月＝5行：合計・新規・再来・準固定・固定） ----
  let r = 7;
  for (const m of table) {
    const lines: [string, RepeatCell][] = [["合計", m.total], ...CLASS_ORDER.map(k => [CLASS_LABEL[k], m.rows[k]] as [string, RepeatCell])];
    lines.forEach(([label, cell], i) => {
      ws.getRow(r).height = 14;
      put(`B${r}`, i === 0 ? m.ym.replace("-", "/") : null, { h: "center", bg: GREEN }); border(`B${r}`, { left: thin, ...(i === lines.length - 1 ? { bottom: thin } : {}) });
      put(`C${r}`, label, { h: "center", bg: GREEN }); border(`C${r}`, { left: thin, bottom: thin });
      merge(`${COUNT_CELL[0]}${r}`, `${COUNT_CELL[1]}${r}`); put(`${COUNT_CELL[0]}${r}`, cell.visitors, { fmt: "#,##0", h: "right" }); border(`D${r}`, { left: thin, bottom: thin }); border(`E${r}`, { bottom: thin });
      BUCKET_CELLS.forEach(([[ca, cb], [pa, pb]], k) => {
        merge(`${ca}${r}`, `${cb}${r}`); put(`${ca}${r}`, cell.buckets[k], { fmt: "#,##0", h: "right" });
        merge(`${pa}${r}`, `${pb}${r}`); put(`${pa}${r}`, ratio(cell.buckets[k], cell.visitors), { fmt: "#0.0%", h: "right" });
        border(`${ca}${r}`, { left: thin, bottom: thin }); border(`${cb}${r}`, { bottom: thin });
        border(`${pa}${r}`, { bottom: thin }); border(`${pb}${r}`, { bottom: thin });
      });
      border(`AC${r}`, { right: thin });
      r++;
    });
  }

  // ---- 作成日時・ページ ----
  ws.getRow(r).height = 23; r++;
  ws.getRow(r).height = 19;
  merge(`B${r}`, `G${r}`); put(`B${r}`, h.createdAt ?? new Date(), { fmt: "yyyy/mm/dd hh:mm:ss" });
  merge(`M${r}`, `P${r}`); put(`M${r}`, "1  /  ", { h: "right" });
  merge(`Q${r}`, `R${r}`); put(`Q${r}`, 1);
  ws.getRow(r + 1).height = 25;
  ws.pageSetup.printArea = `A1:AD${r + 1}`;
  return wb;
}

export async function downloadRepeatXlsx(table: RepeatMonth[], h: RepeatXlsxHead, fileName: string) {
  const wb = await buildRepeatWorkbook(table, h);
  const buf = await wb.xlsx.writeBuffer();
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
  a.download = fileName; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
