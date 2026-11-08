// プライバシーポリシー・利用規約のページ（/r/[storeSlug]/privacy・/terms）の材料をサーバで読む。
// 本番：サービスキーで stores（店舗名・電話・住所）と companies（会社名・正式な事業者名 legal_name）だけを読む。お客様の情報は読まない。
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
    // 0022：事業者名は companies.legal_name（規約・ポリシーの表示だけ）。無ければ name。0022 より前の DB では legal_name の列が無いので name だけで読み直す
    type Co = { name: string | null; legal_name?: string | null };
    type Row = { slug: string; name: string; phone: string | null; address: string | null; companies: Co | Co[] | null };
    let r = await sb.from("stores").select("slug, name, phone, address, companies(name, legal_name)").eq("slug", slug).maybeSingle();
    if (r.error) r = await sb.from("stores").select("slug, name, phone, address, companies(name)").eq("slug", slug).maybeSingle();
    if (r.error || !r.data) return null;
    const d = r.data as unknown as Row;
    const co = Array.isArray(d.companies) ? d.companies[0] : d.companies;
    return { slug: d.slug, name: d.name, phone: d.phone, address: d.address, company_name: (co?.legal_name || "").trim() || co?.name || null };
  }
  if (url) return null;   // 本番でサービスキーが無い：出せない（「準備中」）
  const { memoryLegalStore } = await import("./db/memory");
  return memoryLegalStore(slug);
});
