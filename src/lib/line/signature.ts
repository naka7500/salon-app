// LINE の Webhook の署名（X-Line-Signature）＝本文を チャネルシークレット で HMAC-SHA256 → Base64。
// 一定時間で比べる（timingSafeEqual）。サーバ（Next.js のルート）だけで使う。
import { createHmac, timingSafeEqual } from "node:crypto";

export function lineSignature(rawBody: string, channelSecret: string) {
  return createHmac("sha256", channelSecret).update(rawBody, "utf8").digest("base64");
}
export function verifyLineSignature(rawBody: string, channelSecret: string | null | undefined, header: string | null | undefined) {
  if (!channelSecret || !header || header.length > 200) return false;
  const a = Buffer.from(lineSignature(rawBody, channelSecret), "utf8");
  const b = Buffer.from(header.trim(), "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}
