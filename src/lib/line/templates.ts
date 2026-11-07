// LINE の文面（店舗ごとに変えられる）。増美さんの LINE の書き方に合わせる：
//  区切り線は使わない／記号は ◆ と ▶ だけ／ていねいに／急がせる言葉（限定・今だけ・残りわずか など）は使わない／予約のリンクは1つだけ
import type { ConfirmAnswer, LineOutMessage, LineTemplateKey, LineTemplates } from "./types";

export const DEFAULT_TEMPLATES: LineTemplates = {
  confirm: "{name}様\n\n明日のご予約のご確認です。\n\n◆日時　{date} {time}〜\n◆メニュー　{menu}\n◆店舗　{store}\n\nご来店をお待ちしております。\n下のボタンでお知らせいただけますと助かります。",
  revisit: "{name}様\n\n{store}です。\n前回のご来店から{days}日ほど経ちました。\nそろそろお手入れの時期かと思い、ご案内いたします。\n\n▶ご予約はこちら\n{url}\n\nご都合のよいときにご利用ください。",
  ok_reply: "ご連絡ありがとうございます。\n明日お待ちしております。",
  change_reply: "ご連絡ありがとうございます。\nスタッフより改めてご連絡いたします。\nお急ぎの場合はお電話でもどうぞ。\n◆電話　{phone}",
  ack: "メッセージありがとうございます。\n内容を確認して、スタッフよりお返事いたします。",
};
export const TEMPLATE_LABEL: Record<LineTemplateKey, string> = {
  confirm: "前日確認（ボタン2つが付きます）", revisit: "再来のご案内", ok_reply: "「予定どおり伺います」を押した人への返事",
  change_reply: "「変更したい」を押した人への返事", ack: "メッセージが来たときの自動のお礼（既定はオフ）",
};
/** 差し込める言葉 */
export const TEMPLATE_VARS: Record<LineTemplateKey, string[]> = {
  confirm: ["name", "date", "time", "menu", "store"], revisit: ["name", "store", "days", "menu", "url"],
  ok_reply: ["name", "store"], change_reply: ["name", "store", "phone"], ack: ["name", "store"],
};
export const VAR_LABEL: Record<string, string> = { name: "お名前", date: "日付", time: "時刻", menu: "メニュー", store: "店舗名", days: "前回からの日数", url: "予約ページのURL", phone: "店舗の電話" };

export const templateOf = (key: LineTemplateKey, custom?: Partial<LineTemplates> | null) => (custom?.[key]?.trim() ? custom[key]! : DEFAULT_TEMPLATES[key]);

/** {name} などを差し込む。値が空の差し込みがある行は消す（「◆電話　」だけが残らないように） */
export function renderTemplate(tpl: string, vars: Record<string, string | number | null | undefined>) {
  const lines = tpl.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  for (const line of lines) {
    let empty = false;
    const r = line.replace(/\{([a-z_]+)\}/g, (_, k: string) => { const v = vars[k]; if (v === null || v === undefined || String(v) === "") { empty = true; return ""; } return String(v); });
    if (!empty) out.push(r);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

const FORBIDDEN = ["限定", "今だけ", "いまだけ", "残りわずか", "残り僅か", "お急ぎください", "急いで", "ラストチャンス", "早い者勝ち", "本日まで", "見逃さないで"];
const OTHER_MARKS = /[●○■□◇★☆♪→⇒✓✔︎※▼▲►▷◎◯]/;
const RULE_LINE = /^[\s]*([\-ー─━=＝_＿~〜・*＊.。…]){4,}[\s]*$/m;

/** 文面のチェック。errors＝保存できない／warnings＝気をつけるところ */
export function checkTemplate(text: string, key?: LineTemplateKey) {
  const errors: string[] = [], warnings: string[] = [];
  if (!text.trim()) errors.push("文面が空です");
  if (RULE_LINE.test(text)) errors.push("区切り線（ーーー・━━━ など）は使わないでください");
  const bad = FORBIDDEN.filter(w => text.includes(w));
  if (bad.length) errors.push(`急がせる言葉は使わないでください：${bad.join("・")}`);
  const urls = (text.match(/https?:\/\/\S+/g) || []).length + (text.match(/\{url\}/g) || []).length;
  if (urls > 1) errors.push("予約のリンクは1つだけにしてください");
  if (OTHER_MARKS.test(text)) warnings.push("記号は ◆ と ▶ だけにしてください（● ★ → などが入っています）");
  const unknown = [...text.matchAll(/\{([a-z_]+)\}/g)].map(m => m[1]).filter(k => key && !TEMPLATE_VARS[key].includes(k));
  if (unknown.length) errors.push(`使えない差し込みがあります：${[...new Set(unknown)].map(k => `{${k}}`).join("・")}`);
  if (text.length > 1500) errors.push("長すぎます（1500文字まで）");
  if (key === "confirm" && text.length > 900) warnings.push("前日確認は短めがおすすめです");
  return { errors, warnings };
}

// ---- 前日確認のボタン（postback）----
export const postbackData = (a: ConfirmAnswer, bookingId: string) => `a=${a}&b=${bookingId}`;
export function parsePostback(data: string | null | undefined): { answer: ConfirmAnswer; bookingId: string } | null {
  if (!data) return null;
  const p = new URLSearchParams(data);
  const a = p.get("a"), b = p.get("b");
  if ((a !== "ok" && a !== "change") || !b || !/^[0-9A-Za-z-]{1,64}$/.test(b)) return null;
  return { answer: a, bookingId: b };
}

/** 前日確認のメッセージ（Flex：本文＋ボタン2つ） */
export function confirmMessage(text: string, bookingId: string, alt: string): LineOutMessage {
  return {
    type: "flex", altText: alt.slice(0, 400),
    contents: {
      type: "bubble",
      body: { type: "box", layout: "vertical", contents: [{ type: "text", text: text.slice(0, 1800), wrap: true, size: "sm" }] },
      footer: { type: "box", layout: "vertical", spacing: "sm", contents: [
        { type: "button", style: "primary", color: "#2d5d49", action: { type: "postback", label: "予定どおり伺います", data: postbackData("ok", bookingId), displayText: "予定どおり伺います" } },
        { type: "button", style: "secondary", action: { type: "postback", label: "変更したい", data: postbackData("change", bookingId), displayText: "変更したい" } },
      ] },
    },
  };
}
export const textMessage = (text: string): LineOutMessage => ({ type: "text", text: text.slice(0, 4900) });

/** 画面のプレビュー用：メッセージを文字にする */
export function previewText(msgs: LineOutMessage[]) {
  return msgs.map(m => {
    if (m.type === "text") return m.text;
    const body = ((m.contents.body as { contents?: { text?: string }[] })?.contents || []).map(c => c.text || "").join("\n");
    const btns = ((m.contents.footer as { contents?: { action?: { label?: string } }[] })?.contents || []).map(c => `［${c.action?.label}］`).join(" ");
    return `${body}${btns ? `\n\n${btns}` : ""}`;
  }).join("\n\n");
}

/** お客様が送る「配信停止」「配信再開」 */
export function optKeyword(text: string | null | undefined): "stop" | "resume" | null {
  const t = (text || "").replace(/\s/g, "");
  if (/^(配信停止|お知らせ停止|停止)$/.test(t)) return "stop";
  if (/^(配信再開|お知らせ再開|再開)$/.test(t)) return "resume";
  return null;
}
export const OPT_STOP_REPLY = "お知らせの配信を停止しました。\n再開されるときは「配信再開」とお送りください。";
export const OPT_RESUME_REPLY = "お知らせの配信を再開しました。\n停止されるときは「配信停止」とお送りください。";
