// お客様用ネット予約ページの文言（日本語／英語）
export type Lang = "ja" | "en";
export const T = {
  ja: {
    book: "ネット予約", coupon: "クーポン", menu: "メニュー", minutes: "分", taxIn: "（税込）", choose: "選ぶ", next: "次へ", back: "戻る",
    steps: ["メニュー", "日時", "お客様情報", "問診", "確認"],
    pickMenu: "メニュー・クーポンを選んでください", codeQ: "クーポンコードをお持ちの方", apply: "適用", codeOk: "コードのクーポンを表示しました", codeNg: "このコードのクーポンは見つかりませんでした",
    forNew: "初めての方", forRepeat: "再来の方", pair: "2名様", couponMenu: "このクーポンで受けるメニュー", allMenus: "すべての技術メニュー",
    staff: "担当", noNom: "指名なし（おまかせ）", pickDate: "日付を選んでください", pickTime: "時間を選んでください", noSlot: "この日は空きがありません", legend: "◎ 空きあり　△ 残りわずか　× 空きなし",
    prevMonth: "前の月", nextMonth: "次の月", loading: "読み込み中…",
    info: "お客様情報", name: "お名前", kana: "フリガナ", phone: "電話番号", email: "メールアドレス", namePh: "山田 花子", kanaPh: "ヤマダ ハナコ", required: "必須",
    phoneNote: "ご来店歴の確認と、当日のご連絡に使います", intake: "事前問診", intakeNote: "施術を安全に行うための質問です。分かる範囲でお答えください。",
    confirm: "ご予約内容の確認", datetime: "日時", price: "料金", total: "合計", cancelRule: "キャンセルについて", deadline: (d: string) => `${d}までは、予約完了画面のリンクからキャンセルできます。`,
    submit: "この内容で予約する", sending: "送信中…", done: "ご予約が完了しました", bookingNo: "予約番号", cancelLink: "キャンセル用のリンク", copy: "コピー", copied: "コピーしました",
    keep: "この画面のスクリーンショットを保存しておくと安心です。", another: "続けて別の予約をする", people: (n: number) => `${n}名様`, nominated: "（指名）", nomFee: "指名料", included: "を含みます",
    closed: "ネット予約は準備中です", closedNote: "お手数ですが、お電話でご予約ください。", call: "電話する",
    cancelTitle: "ご予約のキャンセル", doCancel: "予約をキャンセルする", cancelConfirm: "このご予約をキャンセルします。よろしいですか？", cancelled: "キャンセルしました", alreadyCancelled: "このご予約はキャンセル済みです",
    pastDeadline: "キャンセル期限を過ぎています。お手数ですが店舗にお電話ください。", backToTop: "予約ページへ", status: "状態", statusBooked: "ご予約中", statusDone: "ご来店済み",
    option: "オプション", pickOption: "オプションを選んでください", optional: "任意", pickOne: "（1つ選ぶ）", pickAny: "（いくつでも）", optionNeed: (g: string) => `「${g}」を選ぶと次へ進めます`,
    perPair: "2名様1組の料金です", perPairShort: "／2名様",
  },
  en: {
    book: "Book online", coupon: "Coupons", menu: "Menu", minutes: "min", taxIn: " (tax incl.)", choose: "Select", next: "Next", back: "Back",
    steps: ["Menu", "Date", "Your info", "Questions", "Confirm"],
    pickMenu: "Choose a menu or coupon", codeQ: "Have a coupon code?", apply: "Apply", codeOk: "Coupon unlocked", codeNg: "No coupon found for this code",
    forNew: "First visit", forRepeat: "Returning", pair: "For 2", couponMenu: "Choose a menu for this coupon", allMenus: "All treatments",
    staff: "Staff", noNom: "No preference", pickDate: "Choose a date", pickTime: "Choose a time", noSlot: "No availability on this day", legend: "◎ Available　△ Few left　× Full",
    prevMonth: "Prev", nextMonth: "Next", loading: "Loading…",
    info: "Your information", name: "Name", kana: "Name reading (optional)", phone: "Phone", email: "Email", namePh: "Hanako Yamada", kanaPh: "", required: "Required",
    phoneNote: "Used to contact you on the day", intake: "Questions", intakeNote: "Please answer so we can treat you safely.",
    confirm: "Please confirm", datetime: "Date & time", price: "Price", total: "Total", cancelRule: "Cancellation", deadline: (d: string) => `You can cancel online until ${d} using the link on the next screen.`,
    submit: "Confirm booking", sending: "Sending…", done: "Your booking is confirmed", bookingNo: "Booking no.", cancelLink: "Cancellation link", copy: "Copy", copied: "Copied",
    keep: "We recommend taking a screenshot of this page.", another: "Make another booking", people: (n: number) => `${n} guests`, nominated: " (requested)", nomFee: "Nomination fee", included: "included",
    closed: "Online booking is coming soon", closedNote: "Please call the salon to book.", call: "Call",
    cancelTitle: "Cancel your booking", doCancel: "Cancel booking", cancelConfirm: "Cancel this booking?", cancelled: "Your booking has been cancelled", alreadyCancelled: "This booking has already been cancelled",
    pastDeadline: "The cancellation deadline has passed. Please call the salon.", backToTop: "Back to booking page", status: "Status", statusBooked: "Booked", statusDone: "Visited",
    option: "Options", pickOption: "Choose your options", optional: "Optional", pickOne: " (choose one)", pickAny: " (any)", optionNeed: (g: string) => `Please choose: ${g}`,
    perPair: "Price is for 2 guests", perPairShort: " / 2 guests",
  },
} as const;

const WDJ = ["日", "月", "火", "水", "木", "金", "土"];
const WDE = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** 日付（YYYY-MM-DD）の表示 */
export function fmtDate(d: string, lang: Lang) {
  const x = new Date(`${d}T00:00:00`);
  return lang === "ja" ? `${x.getMonth() + 1}月${x.getDate()}日（${WDJ[x.getDay()]}）` : `${WDE[x.getDay()]}, ${MON[x.getMonth()]} ${x.getDate()}`;
}
export function fmtDateTime(iso: string, lang: Lang) {
  const x = new Date(iso); const d = `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
  return `${fmtDate(d, lang)} ${String(x.getHours()).padStart(2, "0")}:${String(x.getMinutes()).padStart(2, "0")}`;
}
export const yenFmt = (n: number) => "¥" + n.toLocaleString("ja-JP");
export const LANG_KEY = "salon-app.web-lang";
export function initialLang(): Lang {
  try { const v = localStorage.getItem(LANG_KEY); if (v === "ja" || v === "en") return v; } catch {}
  if (typeof navigator !== "undefined" && navigator.language && !navigator.language.toLowerCase().startsWith("ja")) return "en";
  return "ja";
}
