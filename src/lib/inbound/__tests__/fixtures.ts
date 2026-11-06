// HPB予約通知メールのテスト用の見本（すべて作りもの。実在のお客様の情報は入れていない）。
// 本物のメールの形はまだ分からないので、ありそうな形をいくつか用意した。本物が届いたら、個人情報を消してここに足す。
export interface Fixture { name: string; subject: string; body: string; date?: string }

/** A：■見出し＋次の行に値（よくある形） */
export const A_NEW_BLOCK: Fixture = {
  name: "A 新規・■見出し＋次の行",
  date: "2026-11-06T10:00:00+09:00",
  subject: "【SALON BOARD】予約通知（BE01234567）",
  body: `KOKAGE西五反田 様

ホットペッパービューティーからのお知らせです。
以下の内容でご予約が入りました。

■予約番号
　BE01234567
■氏名
　見本 花子（ミホン ハナコ）様
■来店日時
　2026年11月20日（金）14:00～15:30
■施術時間
　1時間30分
■指名スタッフ
　指名なし
■ご利用クーポン
　【新規】90分サブリミックヘッドスパ 9,900円
■合計金額
　予定金額：9,900円
■電話番号
　090-1111-2222
■ご要望・ご相談
　肩こりがひどいので強めでお願いします。
　初めてです。

──────────────────
SALON BOARD https://salonboard.com/
`,
};

/** B：見出し：値（1行）・全角数字・半角カナ */
export const B_NEW_INLINE_ZENKAKU: Fixture = {
  name: "B 新規・見出し：値・全角数字・半角カナ",
  date: "2026-11-06T10:00:00+09:00",
  subject: "【ホットペッパービューティー】新規予約のお知らせ",
  body: `予約番号：ＢＥ７６５４３２１０
お客様名：見本　太郎　様
氏名（カナ）：ﾐﾎﾝ ﾀﾛｳ
来店日時：２０２６年１２月３日（木）１０：３０
所要時間：６０分
スタッフ：見本スタッフA（指名料５５０円）
クーポン：［再来］クイックヘッドスパ ６０分
お支払い予定金額：￥１０，４５０
電話番号：０８０－３３３３－４４４４
ご要望：特になし
--
HOT PEPPER Beauty / SALON BOARD
`,
};

/** C：【見出し】値・予約日時に終了時刻・電話が +81 */
export const C_NEW_BRACKET: Fixture = {
  name: "C 新規・【見出し】値・+81",
  date: "2026-11-06T10:00:00+09:00",
  subject: "ご予約が入りました［SALON BOARD］",
  body: `【予約番号】BE55550001
【予約日時】2026/11/21(土) 15:00-16:00
【お名前】ミホン ジロウ 様
【メニュー】まつ毛パーマ
【担当】指名なし
【合計】6,600円
【電話】+81 90-5555-6666
サロンボードでご確認ください。
`,
};

/** D：変更通知（変更前／変更後のかたまり） */
export const D_CHANGE_BLOCKS: Fixture = {
  name: "D 変更・変更前／変更後のかたまり",
  date: "2026-11-07T09:00:00+09:00",
  subject: "【SALON BOARD】予約変更通知（BE01234567）",
  body: `ホットペッパービューティー
以下のご予約の内容が変更されました。

■予約番号
　BE01234567
■氏名
　見本 花子（ミホン ハナコ）様
■変更前
　来店日時：2026年11月20日（金）14:00
■変更後
■来店日時
　2026年11月22日（日）11:00～12:30
■ご利用クーポン
　【新規】90分サブリミックヘッドスパ 9,900円
`,
};

/** E：変更通知（同じ行に 旧 → 新・年なし） */
export const E_CHANGE_ARROW: Fixture = {
  name: "E 変更・同じ行に矢印・年なし",
  date: "2026-11-07T09:00:00+09:00",
  subject: "予約内容変更のお知らせ（HOT PEPPER Beauty）",
  body: `予約番号：BE76543210
氏名：見本 太郎 様
来店日時：11月20日(金) 14:00 → 11月21日(土) 16:30
クーポン：クイックヘッドスパ 60分
`,
};

/** F：キャンセル通知（最小限） */
export const F_CANCEL: Fixture = {
  name: "F キャンセル・最小限",
  date: "2026-11-08T09:00:00+09:00",
  subject: "【SALON BOARD】キャンセル通知",
  body: `ホットペッパービューティーでご予約がキャンセルされました。
予約番号：BE01234567
氏名：見本 花子 様
来店日時：2026年11月22日（日）11:00
`,
};

/** G：カミングスーン型の件名（「予約キャンセル通知」「予約変更通知」。細かい言葉を先に判定できるか） */
export const G_CS_CANCEL_SUBJECT: Fixture = { name: "G 件名「予約キャンセル通知」", date: "2026-11-08T09:00:00+09:00", subject: "予約キャンセル通知", body: "予約番号：BE11112222\n来店日時：2026/11/25 13:00\nお名前：見本 三郎\nSALON BOARD" };
export const G_CS_CHANGE_SUBJECT: Fixture = { name: "G 件名「予約変更通知」", date: "2026-11-08T09:00:00+09:00", subject: "予約変更通知", body: "予約番号：BE11112222\n来店日時：2026/11/26 13:00\nお名前：見本 三郎\nSALON BOARD" };

/** H：ペアのクーポン */
export const H_PAIR: Fixture = {
  name: "H 新規・ペアクーポン",
  date: "2026-11-06T10:00:00+09:00",
  subject: "【SALON BOARD】予約通知",
  body: `ホットペッパービューティー
■予約番号
BE99990001
■氏名
見本 四葉（ミホン ヨツバ）様
■来店日時
2026年11月23日（月）13:00
■ご利用クーポン
【ペア】お二人で同じ時間に まつ毛パーマ（2名様）
■指名スタッフ
練習A
`,
};

/** I：予約ではないメール（口コミ） */
export const I_UNKNOWN: Fixture = { name: "I 予約ではないメール", date: "2026-11-06T10:00:00+09:00", subject: "【HOT PEPPER Beauty】口コミが投稿されました", body: "サロンに新しい口コミが投稿されました。\nSALON BOARDでご確認ください。" };

/** J：予約番号が無い */
export const J_NO_NUMBER: Fixture = { name: "J 予約番号なし", date: "2026-11-06T10:00:00+09:00", subject: "【SALON BOARD】予約通知", body: "ホットペッパービューティー\n氏名：見本 五郎 様\n来店日時：2026年11月24日 10:00\nクーポン：まつ毛パーマ" };

/** K：HTML のメール */
export const K_HTML: Fixture = {
  name: "K HTMLのメール",
  date: "2026-11-06T10:00:00+09:00",
  subject: "【SALON BOARD】予約通知",
  body: `<html><body><p>ホットペッパービューティー</p><table><tr><td>予約番号</td><td>BE30303030</td></tr><tr><td>来店日時</td><td>2026年11月27日（金）18:00</td></tr><tr><td>氏名</td><td>見本 六花（ミホン リッカ）様</td></tr><tr><td>クーポン</td><td>眉Wax</td></tr></table></body></html>`,
};

/** L：オーナーが手で転送したメール（Fwd・> の引用） */
export const L_FORWARDED: Fixture = {
  name: "L 転送（Fwd・引用）",
  date: "2026-11-06T10:00:00+09:00",
  subject: "Fwd: 【SALON BOARD】予約通知",
  body: `---------- Forwarded message ---------
From: SALON BOARD <noreply@example.com>
Subject: 【SALON BOARD】予約通知

> ホットペッパービューティーからのお知らせです。
> 予約番号：BE40404040
> 氏名：見本 七海 様
> 来店日時：2026年11月28日（土）11:00
> クーポン：マツエク 100本
`,
};

/** M：午後◯時◯分 */
export const M_GOGO: Fixture = { name: "M 午後2時30分", date: "2026-11-06T10:00:00+09:00", subject: "予約通知（SALON BOARD）", body: "予約番号：BE50505050\n来店日時：11月29日(日) 午後2時30分\n氏名：見本 八重 様\n施術時間：90分\nメニュー：90分リラクゼーションヘッドスパ" };

/** P：年またぎ（12月末のメールで「1月5日」） */
export const P_YEAR_WRAP: Fixture = { name: "P 年またぎ", date: "2026-12-28T10:00:00+09:00", subject: "【SALON BOARD】予約通知", body: "予約番号：BE60606060\n来店日時：1月5日(火) 10:00\n氏名：見本 九 様\nクーポン：まつ毛パーマ" };

/** Q：予約番号の形が既定と違う（設定で形を足す） */
export const Q_CUSTOM_NUMBER: Fixture = { name: "Q 予約番号の形が違う", date: "2026-11-06T10:00:00+09:00", subject: "【SALON BOARD】予約通知", body: "受付 HB123456 です\n来店日時：2026年11月30日 12:00\n氏名：見本 十 様" };

export const ALL_FIXTURES = [A_NEW_BLOCK, B_NEW_INLINE_ZENKAKU, C_NEW_BRACKET, D_CHANGE_BLOCKS, E_CHANGE_ARROW, F_CANCEL, G_CS_CANCEL_SUBJECT, G_CS_CHANGE_SUBJECT, H_PAIR, I_UNKNOWN, J_NO_NUMBER, K_HTML, L_FORWARDED, M_GOGO, P_YEAR_WRAP, Q_CUSTOM_NUMBER];
