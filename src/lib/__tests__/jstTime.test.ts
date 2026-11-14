// 監査 2026-11-15 M1：端末の時計が日本時間でなくても、予約ページは店舗の時刻（日本時間）で動く。
// テスト中にこのプロセスのタイムゾーンを変えて、結果が変わらないことを確かめる。
import { describe, it, expect, afterAll } from "vitest";
import { addDaysYmd, addMonthYm, cancelDeadlineIso, daysInMonth, jstIso, jstParts, jstToday, ymdParts } from "@/lib/jstTime";
import { fmtDate, fmtDateTime } from "@/app/r/i18n";

const ORIG_TZ = process.env.TZ;
afterAll(() => { if (ORIG_TZ === undefined) delete process.env.TZ; else process.env.TZ = ORIG_TZ; });
const ZONES = ["Asia/Tokyo", "UTC", "Asia/Shanghai", "America/Los_Angeles", "Pacific/Kiritimati", "Europe/London"];

describe.each(ZONES)("端末のタイムゾーンが %s のとき", tz => {
  const run = <T,>(f: () => T) => { process.env.TZ = tz; return f(); };
  it("タイムゾーンの切り替えが効いている（テストの前提）", () => {
    run(() => expect(new Date(2026, 11, 1, 0, 0).toISOString()).toBe({ "Asia/Tokyo": "2026-11-30T15:00:00.000Z", UTC: "2026-12-01T00:00:00.000Z", "Asia/Shanghai": "2026-11-30T16:00:00.000Z", "America/Los_Angeles": "2026-12-01T08:00:00.000Z", "Pacific/Kiritimati": "2026-11-30T10:00:00.000Z", "Europe/London": "2026-12-01T00:00:00.000Z" }[tz]));
  });
  it("画面で選んだ 12/1 15:00 は、日本時間の 15:00（＝UTC 06:00）として送る", () => {
    run(() => { expect(jstIso("2026-12-01", "15:00")).toBe("2026-12-01T15:00:00+09:00"); expect(new Date(jstIso("2026-12-01", "15:00")).toISOString()).toBe("2026-12-01T06:00:00.000Z"); });
  });
  it("朝いちばん・夜おそくの枠も日付がずれない", () => {
    run(() => { expect(new Date(jstIso("2026-12-01", "00:30")).toISOString()).toBe("2026-11-30T15:30:00.000Z"); expect(new Date(jstIso("2026-12-31", "23:30")).toISOString()).toBe("2026-12-31T14:30:00.000Z"); expect(jstIso("2026-12-01", "9:05")).toBe("2026-12-01T09:05:00+09:00"); });
  });
  it("サーバから返った開始時刻は、日本時間で表示する", () => {
    run(() => {
      expect(jstParts("2026-12-01T06:00:00+00:00")).toEqual({ date: "2026-12-01", time: "15:00", dow: 2 });
      expect(fmtDateTime("2026-12-01T06:00:00+00:00", "ja")).toBe("12月1日（火） 15:00");
      expect(fmtDateTime("2026-12-31T15:30:00Z", "ja")).toBe("1月1日（金） 00:30");
      expect(fmtDateTime("2026-12-01T06:00:00Z", "en")).toBe("Tue, Dec 1 15:00");
    });
  });
  it("日付の表示・曜日・月の計算も端末の時計に左右されない", () => {
    run(() => {
      expect(fmtDate("2026-12-01", "ja")).toBe("12月1日（火）"); expect(fmtDate("2027-01-01", "en")).toBe("Fri, Jan 1");
      expect(ymdParts("2026-12-01")).toEqual({ y: 2026, m: 12, d: 1, dow: 2 });
      expect(addDaysYmd("2026-12-31", 1)).toBe("2027-01-01"); expect(addDaysYmd("2026-03-01", -1)).toBe("2026-02-28");
      expect(addMonthYm("2026-12", 1)).toBe("2027-01"); expect(addMonthYm("2026-01", -1)).toBe("2025-12");
      expect(daysInMonth("2026-02")).toBe(28); expect(daysInMonth("2028-02")).toBe(29); expect(daysInMonth("2026-12")).toBe(31);
    });
  });
  it("今日（日本時間）：日本が日付をまたいだ直後でも合う", () => {
    run(() => { expect(jstToday(new Date("2026-11-30T15:00:00Z"))).toBe("2026-12-01"); expect(jstToday(new Date("2026-11-30T14:59:59Z"))).toBe("2026-11-30"); });
  });
  it("キャンセル期限：予約日の1日前の18:00（日本時間）", () => {
    run(() => { expect(cancelDeadlineIso("2026-12-01", 1, "18:00")).toBe("2026-11-30T18:00:00+09:00"); expect(cancelDeadlineIso("2026-12-01", 0, "09:00:00")).toBe("2026-12-01T09:00:00+09:00"); });
  });
});
