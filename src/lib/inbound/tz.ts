// サーバ（Vercel）は時計が世界標準時（UTC）。予約の空き計算（web.ts の headsAt など）は「その端末の時刻＝日本時間」で書いてあるので、
// HPB取り込みの処理の前に、このプロセスの時刻を日本時間にそろえる（Node は process.env.TZ を変えるとすぐ反映される）。
export function ensureJst() {
  const ok = () => new Date(Date.UTC(2026, 0, 1, 0, 0)).getHours() === 9 && new Date(Date.UTC(2026, 6, 1, 0, 0)).getHours() === 9;
  if (ok()) return;
  process.env.TZ = "Asia/Tokyo";
  if (!ok()) throw new Error("サーバの時刻を日本時間にできませんでした（TZ）");
}
