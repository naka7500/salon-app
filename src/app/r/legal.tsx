// プライバシーポリシー・利用規約の見た目（お客様用・ログイン不要）。文面は src/lib/legal.ts（要確認：下書き）
import Link from "next/link";
import type { LegalDoc, LegalStore } from "@/lib/legal";
import { privacyPath, termsPath } from "@/lib/legal";

export function LegalView({ store, doc, kind }: { store: LegalStore | null; doc: LegalDoc | null; kind: "privacy" | "terms" }) {
  return (
    <div className="min-h-screen bg-paper text-ink">
      <div className="max-w-2xl mx-auto min-h-screen bg-[#fbfcfb] sm:border-x border-line px-4 pb-16">
        <header className="pt-6 pb-3 border-b border-line">
          <div className="text-sm text-stone-500">{store?.name || ""}</div>
          <h1 className="text-2xl font-bold mt-1">{doc?.title || (kind === "privacy" ? "プライバシーポリシー" : "利用規約")}</h1>
        </header>
        {!store || !doc ? (
          <p className="mt-6 text-sm text-stone-600">このページは表示できません（店舗が見つかりません）。</p>
        ) : (
          <article className="mt-4 text-[15px] leading-relaxed">
            <p className="mb-5">{doc.intro}</p>
            {doc.sections.map(s => (
              <section key={s.title} className="mb-5">
                <h2 className="font-bold text-base mb-1.5">{s.title}</h2>
                {s.body.length > 1 && !s.title.includes("お問い合わせ")
                  ? <ul className="list-disc pl-5 space-y-1">{s.body.map(x => <li key={x}>{x}</li>)}</ul>
                  : s.body.map(x => <p key={x} className="mb-1">{x}</p>)}
              </section>
            ))}
            <p className="text-sm text-stone-500 mt-8">制定：{doc.updated}</p>
            <nav className="mt-6 flex flex-wrap gap-4 text-sm">
              <Link className="underline text-canopy-deep" href={`/r/${store.slug}`}>ネット予約へ</Link>
              {kind === "privacy" ? <Link className="underline text-canopy-deep" href={termsPath(store.slug)}>利用規約</Link> : <Link className="underline text-canopy-deep" href={privacyPath(store.slug)}>プライバシーポリシー</Link>}
            </nav>
          </article>
        )}
      </div>
    </div>
  );
}
