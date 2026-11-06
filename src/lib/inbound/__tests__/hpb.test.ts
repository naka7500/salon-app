import { describe, expect, it } from "vitest";
import { parseHpbMail, mergeHpbConfig, detectKind, applyManualFix, DEFAULT_HPB_CONFIG } from "../hpb";
import { makeTestMail } from "../testMail";
import * as F from "./fixtures";

describe("HPBメールの読み取り", () => {
  it("A：■見出し＋次の行（新規）", () => {
    const p = parseHpbMail(F.A_NEW_BLOCK);
    expect(p.kind).toBe("new");
    expect(p.reservationNo).toBe("BE01234567");
    expect(p.date).toBe("2026-11-20");
    expect(p.start).toBe("14:00");
    expect(p.end).toBe("15:30");
    expect(p.durationMin).toBe(90);
    expect(p.startIso).toBe("2026-11-20T05:00:00.000Z");
    expect(p.name).toBe("見本 花子");
    expect(p.kana).toBe("ミホン ハナコ");
    expect(p.phone).toBe("09011112222");
    expect(p.coupon).toContain("90分サブリミックヘッドスパ");
    expect(p.staff).toBeNull();
    expect(p.nominated).toBe(false);
    expect(p.total).toBe(9900);
    expect(p.request).toContain("肩こり");
    expect(p.request).toContain("初めてです");
    expect(p.people).toBe(1);
    expect(p.looksLikeHpb).toBe(true);
    expect(p.ok).toBe(true);
    expect(p.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it("B：見出し：値・全角数字・半角カナ・指名料つきのスタッフ", () => {
    const p = parseHpbMail(F.B_NEW_INLINE_ZENKAKU);
    expect(p.kind).toBe("new");
    expect(p.reservationNo).toBe("BE76543210");
    expect(p.date).toBe("2026-12-03");
    expect(p.start).toBe("10:30");
    expect(p.durationMin).toBe(60);
    expect(p.name).toBe("見本 太郎");
    expect(p.kana).toBe("ミホン タロウ");
    expect(p.staff).toBe("見本スタッフA");
    expect(p.nominated).toBe(true);
    expect(p.coupon).toContain("クイックヘッドスパ");
    expect(p.total).toBe(10450);
    expect(p.phone).toBe("08033334444");
    expect(p.request).toBeNull();
    expect(p.ok).toBe(true);
  });

  it("C：【見出し】値・開始〜終了から施術時間・+81の電話", () => {
    const p = parseHpbMail(F.C_NEW_BRACKET);
    expect(p.kind).toBe("new");
    expect(p.reservationNo).toBe("BE55550001");
    expect(p.date).toBe("2026-11-21");
    expect(p.start).toBe("15:00");
    expect(p.end).toBe("16:00");
    expect(p.durationMin).toBe(60);
    expect(p.name).toBe("ミホン ジロウ");
    expect(p.kana).toBe("ミホン ジロウ");
    expect(p.menu).toBe("まつ毛パーマ");
    expect(p.phone).toBe("09055556666");
    expect(p.total).toBe(6600);
    expect(p.staff).toBeNull();
  });

  it("D：変更通知（変更前／変更後のかたまり）は変更後の日時を使う", () => {
    const p = parseHpbMail(F.D_CHANGE_BLOCKS);
    expect(p.kind).toBe("change");
    expect(p.reservationNo).toBe("BE01234567");
    expect(p.date).toBe("2026-11-22");
    expect(p.start).toBe("11:00");
    expect(p.durationMin).toBe(90);
    expect(p.prev).toEqual({ date: "2026-11-20", start: "14:00" });
  });

  it("E：変更通知（同じ行に 旧 → 新・年なし）", () => {
    const p = parseHpbMail(F.E_CHANGE_ARROW);
    expect(p.kind).toBe("change");
    expect(p.date).toBe("2026-11-21");
    expect(p.start).toBe("16:30");
    expect(p.prev?.start).toBe("14:00");
  });

  it("F：キャンセル通知（予約番号があれば ok）", () => {
    const p = parseHpbMail(F.F_CANCEL);
    expect(p.kind).toBe("cancel");
    expect(p.reservationNo).toBe("BE01234567");
    expect(p.ok).toBe(true);
  });

  it("G：「予約キャンセル通知」「予約変更通知」は「予約通知」より先に判定する", () => {
    expect(parseHpbMail(F.G_CS_CANCEL_SUBJECT).kind).toBe("cancel");
    expect(parseHpbMail(F.G_CS_CHANGE_SUBJECT).kind).toBe("change");
    expect(detectKind("予約通知", "").kind).toBe("new");
    expect(detectKind("Re: お問い合わせ", "").kind).toBe("unknown");
  });

  it("H：ペアのクーポンは人数2・指名スタッフあり", () => {
    const p = parseHpbMail(F.H_PAIR);
    expect(p.people).toBe(2);
    expect(p.peopleHint).toContain("ペア");
    expect(p.staff).toBe("練習A");
    expect(p.nominated).toBe(true);
  });

  it("I：予約ではないメールは不明・ok=false", () => {
    const p = parseHpbMail(F.I_UNKNOWN);
    expect(p.kind).toBe("unknown");
    expect(p.ok).toBe(false);
    expect(p.missing).toContain("種類（新規・変更・キャンセル）");
  });

  it("J：予約番号が無いときは ok=false（要確認）", () => {
    const p = parseHpbMail(F.J_NO_NUMBER);
    expect(p.kind).toBe("new");
    expect(p.reservationNo).toBeNull();
    expect(p.missing).toContain("予約番号");
    expect(p.ok).toBe(false);
  });

  it("K：HTMLのメールも読める", () => {
    const p = parseHpbMail(F.K_HTML);
    expect(p.reservationNo).toBe("BE30303030");
    expect(p.date).toBe("2026-11-27");
    expect(p.start).toBe("18:00");
    expect(p.kana).toBe("ミホン リッカ");
    expect(p.coupon).toBe("眉Wax");
  });

  it("L：転送（Fwd・> の引用）も読める", () => {
    const p = parseHpbMail(F.L_FORWARDED);
    expect(p.kind).toBe("new");
    expect(p.reservationNo).toBe("BE40404040");
    expect(p.start).toBe("11:00");
    expect(p.coupon).toBe("マツエク 100本");
  });

  it("M：午後2時30分", () => {
    const p = parseHpbMail(F.M_GOGO);
    expect(p.start).toBe("14:30");
    expect(p.date).toBe("2026-11-29");
    expect(p.durationMin).toBe(90);
  });

  it("P：年またぎ（12月末のメールで1月5日 → 翌年）", () => {
    expect(parseHpbMail(F.P_YEAR_WRAP).date).toBe("2027-01-05");
  });

  it("Q：予約番号の形は設定で足せる", () => {
    const def = parseHpbMail(F.Q_CUSTOM_NUMBER);
    expect(def.reservationNo).toBeNull();
    const p = parseHpbMail(F.Q_CUSTOM_NUMBER, mergeHpbConfig({ reservationNoPatterns: ["HB\\d{6}"] }));
    expect(p.reservationNo).toBe("HB123456");
  });

  it("設定で件名の言葉を足せる・壊れた正規表現は無視する", () => {
    const cfg = mergeHpbConfig({ newWords: ["ご来店予定"], reservationNoPatterns: ["(("] });
    expect(detectKind("ご来店予定のお知らせ", "", cfg).kind).toBe("new");
    expect(cfg.reservationNoPatterns.length).toBe(DEFAULT_HPB_CONFIG.reservationNoPatterns.length);
  });

  it("手で直した値をかぶせると ok になる", () => {
    const p = applyManualFix(parseHpbMail(F.J_NO_NUMBER), { reservationNo: "BE77777777" });
    expect(p.reservationNo).toBe("BE77777777");
    expect(p.ok).toBe(true);
    expect(p.missing).not.toContain("予約番号");
  });

  it("テストメール（新規・変更・キャンセル）は自分で読める", () => {
    const n = makeTestMail({ kind: "new", date: "2026-11-20", start: "13:00", minutes: 75, coupon: "【新規】マツエク 100本", staff: null, total: 7700 });
    const pn = parseHpbMail({ subject: n.subject, body: n.body });
    expect(pn).toMatchObject({ kind: "new", reservationNo: n.reservationNo, date: "2026-11-20", start: "13:00", durationMin: 75, ok: true, people: 1 });
    const c = makeTestMail({ kind: "change", date: "2026-11-21", start: "15:00", minutes: 60, coupon: "x", reservationNo: n.reservationNo, prevDate: "2026-11-20", prevStart: "13:00" });
    const pc = parseHpbMail({ subject: c.subject, body: c.body });
    expect(pc).toMatchObject({ kind: "change", reservationNo: n.reservationNo, date: "2026-11-21", start: "15:00" });
    expect(pc.prev).toEqual({ date: "2026-11-20", start: "13:00" });
    const x = makeTestMail({ kind: "cancel", date: "2026-11-21", start: "15:00", minutes: 60, coupon: "x", reservationNo: n.reservationNo });
    expect(parseHpbMail({ subject: x.subject, body: x.body })).toMatchObject({ kind: "cancel", reservationNo: n.reservationNo, ok: true });
  });

  it("どの見本でも例外を出さない", () => {
    for (const f of F.ALL_FIXTURES) expect(() => parseHpbMail(f)).not.toThrow();
    expect(() => parseHpbMail({ subject: "", body: "" })).not.toThrow();
  });
});
