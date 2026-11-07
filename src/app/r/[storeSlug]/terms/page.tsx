// 利用規約（お客様用・ログイン不要）。LINE Developers の「利用規約URL」に貼る。
// ※要確認：文面は下書き（src/lib/legal.ts）。公開前にオーナーが内容を確かめること。
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { legalStore } from "@/lib/legalServer";
import { termsOfUse } from "@/lib/legal";
import { LegalView } from "../../legal";

export const dynamic = "force-dynamic";
type Props = { params: Promise<{ storeSlug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const s = await legalStore((await params).storeSlug).catch(() => null);
  return { title: s ? `利用規約｜${s.name}` : "利用規約" };
}
export default async function TermsPage({ params }: Props) {
  const s = await legalStore((await params).storeSlug).catch(() => null);
  if (!s) notFound();
  return <LegalView store={s} doc={termsOfUse(s)} kind="terms" />;
}
