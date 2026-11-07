import type { NextConfig } from "next";

// セキュリティの見出し（監査 2026-11-08 L1）
//  - よそのページへの埋め込み禁止（クリックジャッキング対策）。LIFF（/r/*）は LINE の中のブラウザで開く＝iframe ではないので問題なし
//  - Referrer-Policy：よそへ送るのはオリジンだけ（キャンセル用のトークンが URL に入るため）。キャンセルのページは何も送らない
//  - CSP は壊さない範囲だけ強制（frame-ancestors・object-src・base-uri・form-action）。script/style/connect は Supabase・LIFF・LINE を
//    使うので、まずは Report-Only で様子を見る（ブラウザのコンソールに出るだけで、何も止めない）
const enforcedCsp = ["frame-ancestors 'none'", "object-src 'none'", "base-uri 'self'", "form-action 'self'"].join("; ");
const reportOnlyCsp = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://static.line-scdn.net",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "connect-src 'self' https://*.supabase.co wss://*.supabase.co https://api.line.me https://access.line.me https://liffsdk.line-scdn.net",
  "frame-src 'self' https://access.line.me",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()" },
  { key: "Content-Security-Policy", value: enforcedCsp },
  { key: "Content-Security-Policy-Report-Only", value: reportOnlyCsp },
];

const nextConfig: NextConfig = {
  /* config options here */

  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      // キャンセル用のページ（URL にトークン）は、よそに Referer を一切送らない
      { source: "/r/:storeSlug/cancel/:token*", headers: [{ key: "Referrer-Policy", value: "no-referrer" }] },
    ];
  },

  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
