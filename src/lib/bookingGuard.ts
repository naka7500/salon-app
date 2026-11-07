// スタッフ側の予約の「重なり」チェック（0014 のトリガー guard_booking_overlap が返すエラー）。
// staff_overlap＝同じ担当が同じ時間にほかの予約・休憩・×を持っている／rooms_full＝部屋（ベッド）が足りない。
// スタッフは「それでも入れる」を選べる（予約に alert='forced' を付けて保存＝あとで分かるように）。
export const OVERLAP_FORCED = "forced";
export const isOverlapError = (m: string) => /staff_overlap|rooms_full/.test(m);
export function overlapText(m: string) {
  if (m.includes("rooms_full")) return "この時間は部屋（ベッド）が足りません（ほかの予約で埋まっています）。";
  return "この担当は、この時間にほかの予約・休憩・×が入っています（ほかの端末やネット予約で先に入った可能性があります）。";
}
