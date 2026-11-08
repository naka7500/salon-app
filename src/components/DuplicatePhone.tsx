"use client";
// 同じ電話番号のお客様がいるときのヒントと「統合する」（0022・案B）。
//  ・LINE予約（LIFF）は LINE のユーザーIDが本人なので、既存のお客様と同じ電話番号でも別のお客様として登録される。
//    自動では統合しない。スタッフが顧客詳細・予約詳細でこのヒントを見て、本人と確かめてから「統合する」を押す（元に戻せない）
//  ・統合できるのは在籍のオーナー・店長・スタッフ（サーバ＝DB の関数がもう一度確かめる）
import { useCallback, useEffect, useState } from "react";
import { getRepo, type Customer } from "@/lib/db";
import { duplicateHint } from "@/lib/line/linkPolicy";

interface Dup { customer: Customer; visits: number }

export function DuplicatePhoneHint({ customer, compact, onMerged }: { customer: Customer; compact?: boolean; onMerged?: (keptId: string, mergedId: string) => void }) {
  const repo = getRepo();
  const [dups, setDups] = useState<Dup[] | null>(null);
  const [myVisits, setMyVisits] = useState(0);
  const [ask, setAsk] = useState<{ other: Customer; keep: "me" | "other" } | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const load = useCallback(async () => {
    try {
      const list = await repo.customersSamePhone(customer.id);
      if (!list) { setDups([]); return; }
      const out: Dup[] = [];
      for (const c of list) out.push({ customer: c, visits: (await repo.bookingsOfCustomer(c.id).catch(() => [])).filter(b => b.status === "done").length });
      setDups(out);
      if (out.length) setMyVisits((await repo.bookingsOfCustomer(customer.id).catch(() => [])).filter(b => b.status === "done").length);
    } catch { setDups([]); }
  }, [repo, customer.id]);
  useEffect(() => { void Promise.resolve().then(load); }, [load]);
  if (!dups?.length && !msg) return null;
  async function merge() {
    if (!ask || busy) return;
    const keepId = ask.keep === "me" ? customer.id : ask.other.id, mergeId = ask.keep === "me" ? ask.other.id : customer.id;
    setBusy(true);
    try {
      const r = await repo.mergeCustomers(keepId, mergeId);
      setMsg({ ok: true, text: r.message });
      setAsk(null);
      await load();
      onMerged?.(r.kept_id, mergeId);
    } catch (e) { setMsg({ ok: false, text: (e as Error).message }); setAsk(null); }
    finally { setBusy(false); }
  }
  const nameOf = (c: Customer) => `${c.name}${c.kana ? `（${c.kana}）` : ""}`;
  return (
    <div className={`${compact ? "mb-2" : "mb-3"} text-sm px-3 py-2 rounded bg-sky-50 border border-sky-300 text-sky-950`} data-testid="duplicate-phone">
      {(dups || []).map(d => (
        <div key={d.customer.id} className="flex flex-wrap items-center gap-2">
          <span className="font-semibold">⚠ {duplicateHint(d.customer.name, d.visits)}</span>
          <a className="text-xs underline" href={`/customers/${d.customer.id}`}>開く</a>
          {!ask && <button type="button" className="btn !min-h-8 text-xs max-sm:!min-h-11 ml-auto" onClick={() => { setMsg(null); setAsk({ other: d.customer, keep: d.visits > myVisits ? "other" : "me" }); }} data-testid="merge-open">統合する</button>}
        </div>
      ))}
      {!ask && dups && dups.length > 0 && <div className="text-xs mt-1 text-sky-900">LINEからの予約は LINE のアカウントごとにお客様を登録するので、同じ方が別のお客様として入ることがあります。ご本人と確かめてから統合してください（自動では統合しません）。</div>}
      {ask && (
        <div className="mt-2 rounded border border-sky-400 bg-white p-2" role="alertdialog" aria-label="お客様の統合">
          <div className="font-semibold">どちらの登録を残しますか？</div>
          <div className="mt-1 space-y-1">
            {([["me", customer, myVisits], ["other", ask.other, dups!.find(d => d.customer.id === ask.other.id)?.visits ?? 0]] as const).map(([k, c, v]) => (
              <label key={k} className="flex items-start gap-2 text-sm">
                <input type="radio" name="merge-keep" className="mt-1" checked={ask.keep === k} onChange={() => setAsk({ ...ask, keep: k })} />
                <span><b>{nameOf(c)}</b> を残す <span className="text-xs text-ink-soft">（来店{v}回・{c.email || "メールなし"}{c.created_at ? `・登録 ${c.created_at.slice(0, 10)}` : ""}）</span></span>
              </label>
            ))}
          </div>
          <div className="text-xs mt-2 text-ink-soft">もう一方の予約・お会計・カルテ・前のPOSの来店・LINEのつながりを、残す側に移します。もう一方は「統合済み」になり一覧から消えます。<b className="text-danger">元に戻せません。</b>両方に LINE がつながっているときは、残す側の LINE を残します。</div>
          <div className="mt-2 flex gap-2">
            <button type="button" className="btn text-xs border-sky-500" disabled={busy} onClick={merge} data-testid="merge-confirm">{busy ? "…" : "統合する"}</button>
            <button type="button" className="btn text-xs" disabled={busy} onClick={() => setAsk(null)}>やめる</button>
          </div>
        </div>
      )}
      {msg && <div className={`text-xs mt-1 px-2 py-1 rounded border ${msg.ok ? "bg-moss border-line text-canopy-deep" : "bg-amber-50 border-amber-300 text-amber-900"}`} role="status">{msg.text}</div>}
    </div>
  );
}
