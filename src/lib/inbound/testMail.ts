// テスト店舗の「テストメールを送る」で使う、作りもののHPB予約通知メール（実在のお客様の情報は使わない）。
// 本物のメールと同じ処理（解析 → 台帳 → 受信ログ）を通す。
import type { HpbKind } from "./hpb";

export interface TestMailOptions {
  kind: Exclude<HpbKind, "unknown">;
  /** 'YYYY-MM-DD' と 'HH:MM'（日本時間） */
  date: string; start: string;
  /** 施術時間（分） */
  minutes: number;
  coupon: string;
  /** 指名スタッフ（空＝指名なし） */
  staff?: string | null;
  /** 変更・キャンセルのときは、元の予約番号 */
  reservationNo?: string | null;
  name?: string; kana?: string; phone?: string | null;
  total?: number | null; request?: string | null;
  /** 変更前の日時（変更のとき） */
  prevDate?: string | null; prevStart?: string | null;
}

const WD = ["日", "月", "火", "水", "木", "金", "土"];
const fmtDate = (d: string) => { const [y, m, dd] = d.split("-").map(Number); const w = new Date(Date.UTC(y, m - 1, dd)).getUTCDay(); return `${y}年${m}月${dd}日（${WD[w]}）`; };
const addMin = (hm: string, n: number) => { const t = Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5)) + n; return `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`; };

export function newTestReservationNo() { return "BE" + String(Date.now()).slice(-8) + String(Math.floor(Math.random() * 90 + 10)); }

/** 件名と本文。本物の形は分からないので「■見出し／次の行に値」の形（想定する形の1つ） */
export function makeTestMail(o: TestMailOptions) {
  const no = o.reservationNo || newTestReservationNo();
  const subj = o.kind === "new" ? "予約通知" : o.kind === "change" ? "予約変更通知" : "予約キャンセル通知";
  const subject = `【テスト】【SALON BOARD】${subj}（${no}）`;
  const head = o.kind === "new" ? "以下の内容でご予約が入りました。" : o.kind === "change" ? "以下のご予約の内容が変更されました。" : "以下のご予約がキャンセルされました。";
  const lines = [
    "※これはテスト店舗の「テストメールを送る」で作った練習用のメールです（実際の予約ではありません）。",
    "",
    "テスト店舗（練習用） 様",
    "",
    `ホットペッパービューティー（SALON BOARD）からのお知らせです。${head}`,
    "",
    "■予約番号", `　${no}`,
    "■氏名", `　${o.name || "テスト 花子"}（${o.kana || "テスト ハナコ"}）様`,
  ];
  if (o.kind === "change" && o.prevDate && o.prevStart) lines.push("■変更前", `　来店日時：${fmtDate(o.prevDate)}${o.prevStart}`, "■変更後");
  lines.push("■来店日時", `　${fmtDate(o.date)}${o.start}～${addMin(o.start, o.minutes)}`,
    "■施術時間", `　${Math.floor(o.minutes / 60) ? `${Math.floor(o.minutes / 60)}時間` : ""}${o.minutes % 60 ? `${o.minutes % 60}分` : ""}`,
    "■指名スタッフ", `　${o.staff ? o.staff : "指名なし"}`,
    "■ご利用クーポン", `　${o.coupon}`,
    "■合計金額", `　予定金額：${(o.total ?? 0).toLocaleString("ja-JP")}円`,
    "■電話番号", `　${o.phone ?? "090-0000-9999"}`,
    "■ご要望・ご相談", `　${o.request || "なし"}`,
    "",
    "──────────────────",
    "SALON BOARD　https://salonboard.com/（テスト）",
  );
  return { subject, body: lines.join("\n"), reservationNo: no };
}
