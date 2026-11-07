// プライバシーポリシー・利用規約のページ（/r/[storeSlug]/privacy・/terms）の材料をサーバで読む。
// 本番：サービスキーで stores（店舗名・電話・住所）と companies（会社名）だけを読む。お客様の情報は読まない。
// デモ（Supabase 未設定）：デモの店舗の内容を使う。
import { cache } from "react";
import { createClient } from "@supabase/supabase-js";
import { legalSlugOk, type LegalStore } from "./legal";

// 同じ表示の中（タイトルと本文）で2回読まないように cache で1回にする
export const legalStore = cache(async (rawSlug: string): Promise<LegalStore | null> => {
  const slug = String(rawSlug || "").trim().toLowerCase();
  if (!legalSlugOk(slug)) return null;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (url && key) {
    const sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
    const r = await sb.from("stores").select("slug, name, phone, address, companies(name)").eq("slug", slug).maybeSingle();
    if (r.error || !r.data) return null;
    const d = r.data as unknown as { slug: string; name: string; phone: string | null; address: string | null; companies: { name: string | null } | { name: string | null }[] | null };
    const co = Array.isArray(d.companies) ? d.companies[0] : d.companies;
    return { slug: d.slug, name: d.name, phone: d.phone, address: d.address, company_name: co?.name ?? null };
  }
  if (url) return null;   // 本番でサービスキーが無い：出せない（「準備中」）
  const { memoryLegalStore } = await import("./db/memory");
  return memoryLegalStore(slug);
});
