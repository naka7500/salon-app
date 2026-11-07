"use client";
// ネット予約ページを LINE の中（LIFF）で開いたとき：LINE のログイン → IDトークン（本人の確認はサーバが LINE に問い合わせる）。
// ?liff=1（LIFF のエンドポイント）または ?link=<QRの合言葉> のときだけ動く。デモは LIFF を使わずに「デモのLINE」。
import { useEffect, useState } from "react";
import type { PublicApi } from "@/lib/web";

type Liff = { init(o: { liffId: string }): Promise<void>; isLoggedIn(): boolean; login(o?: { redirectUri?: string }): void; getIDToken(): string | null; getDecodedIDToken(): { name?: string } | null; isInClient(): boolean };
declare global { interface Window { liff?: Liff } }
const SDK = "https://static.line-scdn.net/liff/edge/2/sdk.js";

function loadSdk(): Promise<Liff> {
  return new Promise((ok, ng) => {
    if (window.liff) return ok(window.liff);
    const s = document.createElement("script"); s.src = SDK; s.async = true;
    s.onload = () => (window.liff ? ok(window.liff) : ng(new Error("liff_missing"))); s.onerror = () => ng(new Error("liff_load_failed"));
    document.head.appendChild(s);
  });
}

export type LiffState =
  | { phase: "off" }
  | { phase: "loading" }
  | { phase: "ready"; idToken: string; name: string | null; basicId: string | null; demo: boolean }
  | { phase: "error"; message: string };

export function useLiff(api: PublicApi, slug: string) {
  const [st, setSt] = useState<LiffState>({ phase: "off" });
  const [linkToken, setLinkToken] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    (async () => {
      const q = new URLSearchParams(location.search);
      // LIFF は最初に ?liff.state=… で開くことがある（init のあとで本当のURLになる）
      const wants = q.get("liff") === "1" || q.has("link") || q.has("liff.state");
      if (!wants || !api.lineInfo) return;
      setSt({ phase: "loading" });
      const info = await api.lineInfo(slug).catch(() => null);
      if (!info) { if (live) setSt({ phase: "error", message: "この店舗のLINE連携は準備中です" }); return; }
      if (api.mode === "memory") {
        if (live) { setLinkToken(q.get("link")); setSt({ phase: "ready", idToken: "demo", name: "デモのLINE", basicId: info.basic_id ?? null, demo: true }); }
        return;
      }
      try {
        const liff = await loadSdk();
        await liff.init({ liffId: info.liff_id });
        const q2 = new URLSearchParams(location.search);
        if (!liff.isLoggedIn()) { liff.login({ redirectUri: location.href }); return; }
        const tok = liff.getIDToken();
        if (!tok) throw new Error("no_id_token");
        if (live) { setLinkToken(q2.get("link") || q.get("link")); setSt({ phase: "ready", idToken: tok, name: liff.getDecodedIDToken()?.name ?? null, basicId: info.basic_id ?? null, demo: false }); }
      } catch { if (live) setSt({ phase: "error", message: "LINEとの接続に失敗しました。LINEアプリから開き直してください" }); }
    })();
    return () => { live = false; };
  }, [api, slug]);
  return { liff: st, linkToken };
}
export const addFriendUrl = (basicId?: string | null) => (basicId ? `https://line.me/R/ti/p/${encodeURIComponent(basicId)}` : null);
