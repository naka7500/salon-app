// CSV の書き出し（全部の画面で共通）。Excel で開いたときに式として動かないように、
// = + - @ タブ・CR で始まる文字は先頭に ' を付ける（数値はそのまま。お客様名などネット予約・HPBから入る文字への対策）
export function csvCell(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return String(v);
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
export const csvText = (rows: (string | number | null | undefined)[][]) => "﻿" + rows.map(r => r.map(csvCell).join(",")).join("\r\n");
export function downloadCsv(name: string, rows: (string | number | null | undefined)[][]) {
  const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([csvText(rows)], { type: "text/csv" })); a.download = name;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
