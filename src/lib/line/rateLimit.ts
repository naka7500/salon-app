// ログイン不要のAPI（/api/line/me・/api/line/link）の簡易な回数制限（監査 2026-11-07 L4）。
// メモリの中のトークンバケット。限界：Vercel の関数インスタンスごとに別々に数える（同じリージョン1つでも複数インスタンスなら合計はこの何倍かまで通る）、
// 再起動で消える。大量アクセスの「安全柵」であって、厳密な上限ではない。厳密にするなら Vercel Firewall の Rate Limit か DB で数える。
export interface Bucket { tokens: number; at: number }
export interface RateLimiter {
  /** 1回使う。通れば true。key＝IPアドレス等 */
  take(key: string, now?: number): boolean;
  size(): number;
}
/** capacity＝瞬間の最大回数、perMinute＝1分あたりの補充回数 */
export function createRateLimiter(capacity: number, perMinute: number, maxKeys = 5000): RateLimiter {
  const m = new Map<string, Bucket>();
  const refill = perMinute / 60_000;
  return {
    take(key, now = Date.now()) {
      let b = m.get(key);
      if (!b) {
        if (m.size >= maxKeys) {   // 古いものから捨てる（Map は挿入順）
          let n = Math.ceil(maxKeys / 10);
          for (const k of m.keys()) { m.delete(k); if (--n <= 0) break; }
        }
        b = { tokens: capacity, at: now }; m.set(key, b);
      } else {
        b.tokens = Math.min(capacity, b.tokens + (now - b.at) * refill); b.at = now;
      }
      if (b.tokens < 1) return false;
      b.tokens -= 1; return true;
    },
    size() { return m.size; },
  };
}
/** リクエストの送り元（Vercel は x-forwarded-for の先頭が本当の送り元） */
export function clientKey(request: Request): string {
  const h = request.headers;
  const xff = h.get("x-forwarded-for");
  const ip = (xff ? xff.split(",")[0] : null)?.trim() || h.get("x-real-ip")?.trim() || "";
  return ip.slice(0, 64) || "unknown";
}
const g = globalThis as unknown as { __lineRateLimiters?: Record<string, RateLimiter> };
/** 名前ごとに1つ（開発中のホットリロードでも作り直さない） */
export function limiter(name: string, capacity: number, perMinute: number): RateLimiter {
  g.__lineRateLimiters ??= {};
  return (g.__lineRateLimiters[name] ??= createRateLimiter(capacity, perMinute));
}
