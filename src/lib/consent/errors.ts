// 同意書・問診票：DB（0025 のトリガー・関数）が返す合言葉 → 画面に出す日本語
export const CONSENT_ERR: Record<string, string> = {
  consent_template_mismatch: "この書類（テンプレ）は、この店舗では使えません。画面を開き直して選び直してください",
  consent_template_inactive: "この書類（テンプレ）は「使わない」になっています。設定＞同意書・問診票 で確認してください",
  consent_staff_required: "署名の保存は、在籍のスタッフ（閲覧のみ以外）だけができます",
  consent_path_mismatch: "署名済みPDFの置き場所が正しくありません。画面を開き直して、もう一度署名をお願いします",
  consent_file_missing: "署名済みPDFを保存できていません。通信の状態を確かめて、もう一度「署名して保存」を押してください",
  consent_file_size_mismatch: "署名済みPDFが正しく保存できていません。もう一度「署名して保存」を押してください",
  consent_document_immutable: "署名済みの書類は、書き換え・削除できません（オーナーが「取り消し」の印を付けることはできます）",
  consent_void_forbidden: "署名済みの書類の取り消しは、オーナーだけができます",
  consent_void_reason: "取り消しの理由を入れてください（200文字まで）",
  consent_already_voided: "この書類は、もう取り消されています",
  consent_not_found: "書類が見つかりません（画面を開き直してください）",
};
/** DB のエラー文から、わかる日本語にする。知らないものは null */
export function consentErrMsg(m: string | null | undefined): string | null {
  const k = Object.keys(CONSENT_ERR).find(x => (m || "").includes(x));
  return k ? CONSENT_ERR[k] : null;
}
