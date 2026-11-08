// ネット予約ページの「プライバシーポリシー」「利用規約」の文面（店舗名・会社名・電話番号から作る）。
// LINEログイン（LIFF）のチャネルの登録に、この2つのURLが要る（LINE Developers の「プライバシーポリシーURL」「利用規約URL」）。
// ※要確認：文面は下書きです。公開前に、オーナー（必要なら専門家）が内容を確かめてください。
//   とくに「第三者提供」「保存期間」「お問い合わせ先」「制定日」は、店舗の実際の運用に合わせて直すこと。

export interface LegalStore { slug: string; name: string; company_name?: string | null; phone?: string | null; address?: string | null }
export interface LegalSection { title: string; body: string[] }
export interface LegalDoc { title: string; intro: string; sections: LegalSection[]; updated: string }

/** 制定日（要確認：文面を直したら更新する） */
export const LEGAL_UPDATED = "2026年11月7日";

/** 事業者名：会社の正式名（0022 companies.legal_name。例「株式会社BE.COLLECTION.5」）→ 会社名 → 店舗名 */
export function operatorName(s: Pick<LegalStore, "name" | "company_name">) {
  const c = (s.company_name || "").trim();
  return c || s.name.trim();
}
/** 「◯◯（店舗名）」の言い方（例「株式会社BE.COLLECTION.5（ラシエル箱崎）」）。会社名と店舗名が同じなら1回だけ */
export function operatorLabel(s: Pick<LegalStore, "name" | "company_name">) {
  const op = operatorName(s);
  return op === s.name.trim() ? op : `${op}（${s.name.trim()}）`;
}
function contactLines(s: LegalStore) {
  const out = [`${operatorLabel(s)}`];
  if (s.address) out.push(`住所：${s.address}`);
  if (s.phone) out.push(`電話：${s.phone}`);
  if (!s.phone) out.push("お問い合わせは、店頭または公式LINEのメッセージでお願いいたします。");
  return out;
}

export function privacyPolicy(s: LegalStore): LegalDoc {
  const op = operatorLabel(s);
  return {
    title: "プライバシーポリシー",
    intro: `${op}（以下「当店」）は、ご予約やご来店のお客様の個人情報を、以下のとおり大切に取り扱います。`,
    updated: LEGAL_UPDATED,
    sections: [
      { title: "1. いただく情報", body: [
        "お名前・フリガナ",
        "電話番号・メールアドレス",
        "ご予約・ご来店の履歴（日時・メニュー・担当・お会計の内容など）",
        "ご予約のときにお答えいただいた事前の質問の内容",
        "LINEをお使いの場合：LINEのユーザーID・表示名（LINEログインや公式LINEの友だち追加で、お客様が同意されたときだけ）",
      ] },
      { title: "2. 使う目的", body: [
        "ご予約の受付・確認・変更・キャンセルの手続きのため",
        "ご予約の前日のご確認（リマインド）など、ご予約に関するご連絡のため",
        "担当スタッフのお休みなどで、ご予約の変更をお願いするときのご連絡のため",
        "前回のご来店から日が空いたときの、ご来店のご案内のため（LINEのお知らせを止めることもできます）",
        "施術・サービスをよりよくするため（ご来店の記録の確認など）",
      ] },
      { title: "3. 第三者への提供", body: [
        "法令にもとづく場合を除き、お客様の同意なく第三者に提供することはありません。",
        "ご予約の管理・LINEでのご連絡のために、予約システムやLINEのサービス（クラウド）を使います。これらの事業者には、当店の目的の範囲でだけ情報を預けます。",
      ] },
      { title: "4. 保存と安全管理", body: [
        "情報は、アクセスできる人を当店のスタッフに限ったシステムで保存し、通信は暗号化しています。",
        "スタッフには、個人情報を大切に扱うよう指導しています。",
        "使う必要がなくなった情報は、適切な方法で消去します。",
      ] },
      { title: "5. LINEのお知らせを止めるには", body: [
        "公式LINEのトークで「配信停止」と送っていただくと、当店からのお知らせ（前日のご確認・ご来店のご案内など）を止めます。",
        "公式LINEをブロックしていただいても、お知らせは届かなくなります。",
        "再開をご希望の場合は、店頭またはお電話でお知らせください。",
      ] },
      { title: "6. 情報の確認・訂正・削除", body: [
        "ご自身の情報の確認・訂正・削除・利用停止をご希望の場合は、ご本人であることを確かめたうえで対応いたします。下のお問い合わせ先までご連絡ください。",
      ] },
      { title: "7. このポリシーの変更", body: [
        "内容を変更する場合は、このページでお知らせします。",
      ] },
      { title: "8. お問い合わせ先", body: contactLines(s) },
    ],
  };
}

export function termsOfUse(s: LegalStore): LegalDoc {
  const op = operatorLabel(s);
  return {
    title: "利用規約",
    intro: `この規約は、${op}（以下「当店」）のネット予約ページと公式LINE（以下「本サービス」）をお使いいただくときの決まりです。本サービスをお使いになった時点で、この規約に同意いただいたものとします。`,
    updated: LEGAL_UPDATED,
    sections: [
      { title: "1. 本サービスでできること", body: [
        "当店のメニューの確認、ご予約、ご予約のキャンセル",
        "LINEでの、ご予約の前日のご確認・ご予約に関するご連絡・ご来店のご案内の受け取り",
      ] },
      { title: "2. ご予約について", body: [
        "お名前・電話番号などは、正しい内容をご入力ください。",
        "キャンセル・変更の期限と方法は、ご予約のページに書いてあるとおりです。期限を過ぎた場合は、お電話でご連絡ください。",
        "やむを得ない事情（スタッフの急な体調不良など）で、当店からご予約の変更をお願いすることがあります。",
      ] },
      { title: "3. LINEのご利用", body: [
        "LINEでのご連絡は、LINEのサービスを通じてお届けします。LINEの利用には、LINEヤフー株式会社の規約が適用されます。",
        "公式LINEのトークで「配信停止」と送るか、ブロックしていただくと、当店からのお知らせは届かなくなります。",
      ] },
      { title: "4. してはいけないこと", body: [
        "他人になりすましてのご予約、来店するつもりのないご予約",
        "本サービスの運営をさまたげる行為、法令や公序良俗に反する行為",
      ] },
      { title: "5. 本サービスの変更・停止", body: [
        "点検や障害などのため、本サービスを予告なく止めたり、内容を変えたりすることがあります。",
      ] },
      { title: "6. 責任について", body: [
        "当店は、本サービスを安全にお使いいただけるよう努めます。通信の障害など当店の責めによらない事情で生じた損害については、法令で認められる範囲で責任を負いかねます。",
      ] },
      { title: "7. 個人情報", body: [
        "お客様の個人情報は、別に定める「プライバシーポリシー」にしたがって取り扱います。",
      ] },
      { title: "8. お問い合わせ先", body: contactLines(s) },
    ],
  };
}

/** ネット予約ページのURL名として使える形か（英小文字・数字・ハイフン） */
export const legalSlugOk = (slug: string) => /^[a-z0-9][a-z0-9-]{0,62}$/.test(slug);
export const privacyPath = (slug: string) => `/r/${slug}/privacy`;
export const termsPath = (slug: string) => `/r/${slug}/terms`;
