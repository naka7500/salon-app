// お客様用の予約ページの日時：端末の時計がどこの国の時刻でも、店舗の時刻（日本時間＝Asia/Tokyo・UTC+9・夏時間なし）で扱う（監査 2026-11-15 M1）。
// ここの関数は端末のタイムゾーン（Date の getHours など）を一切使わない。
const pad = (n: number) => String(n).padStart(2, "0");
const JST_MS = 9 * 3600_000;

/** 日本時間の 日付（YYYY-MM-DD）・時刻（HH:MM）・曜日（0＝日） */
export function jstParts(d: Date | string | number) {
  const t = new Date(new Date(d).getTime() + JST_MS);
  return { date: `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`, time: `${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}`, dow: t.getUTCDay() };
}
/** 今日（日本時間） */
export const jstToday = (now: Date = new Date()) => jstParts(now).date;
/** 日本時間の 日付＋時刻 → その瞬間（ISO・+09:00 付き）。サーバへ送る開始時刻はこれで作る */
export function jstIso(date: string, time: string) {
  const [h, m] = time.split(":");
  return `${date}T${pad(Number(h))}:${pad(Number(m || 0))}:00+09:00`;
}
/** 日付だけの計算（タイムゾーンに関係しない） */
export function addDaysYmd(d: string, n: number) { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); }
/** 'YYYY-MM' に n か月足す */
export function addMonthYm(ym: string, n: number) { const [y, m] = ym.split("-").map(Number); const x = new Date(Date.UTC(y, m - 1 + n, 1)); return `${x.getUTCFullYear()}-${pad(x.getUTCMonth() + 1)}`; }
/** 日付（YYYY-MM-DD）の曜日（0＝日）・月（1〜12）・日 */
export function ymdParts(d: string) { const x = new Date(`${d}T00:00:00Z`); return { y: x.getUTCFullYear(), m: x.getUTCMonth() + 1, d: x.getUTCDate(), dow: x.getUTCDay() }; }
/** その月の日数 */
export function daysInMonth(ym: string) { const [y, m] = ym.split("-").map(Number); return new Date(Date.UTC(y, m, 0)).getUTCDate(); }
/** キャンセル期限（予約日の days 日前の HH:MM・日本時間）の瞬間（ISO） */
export function cancelDeadlineIso(date: string, days: number, time: string) { return jstIso(addDaysYmd(date, -(days ?? 1)), (time || "18:00").slice(0, 5)); }
