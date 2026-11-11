"use client";
// お客様の詳細＞同意書・問診票（0025）：署名済みの書類の一覧（開く）と、「同意書を取る」（店のタブレットで署名する画面へ）
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getRepo, type ConsentDocument, type ConsentTemplate, type Staff } from "@/lib/db";
import { fmtDate, ymdJst } from "@/lib/consent/pdf";

export function ConsentCard({ customerId, me, staffName }: { customerId: string; me: Staff | null; staffName: (sid?: string | null) => string | undefined }) {
  const repo = getRepo(); const router = useRouter();
  const [docs, setDocs] = useState<ConsentDocument[] | null | undefined>(undefined);
  const [tpls, setTpls] = useState<ConsentTemplate[]>([]);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [tplId, setTplId] = useState("");
  const [msg, setMsg] = useState("");
  const [rev, setRev] = useState(0);
  useEffect(() => {
    let on = true;
    repo.consentDocuments(customerId).then(async d => { if (!on) return; setDocs(d); if (d?.length) setUrls(await repo.consentFileUrls(d.map(x => x.file_path)).catch(() => ({}))); }).catch(() => { if (on) setDocs(null); });
    repo.consentTemplates().then(t => { if (on) setTpls((t || []).filter(x => x.active)); }).catch(() => {});
    return () => { on = false; };
  }, [repo, customerId, rev]);
  if (docs === null) return null;   // 0025 未適用：この枠は出さない（設定の画面で「準備中」と案内する）
  const canSign = !!me && me.role !== "viewer" && me.active !== false;
  const pick = tplId || tpls[0]?.id || "";
  const isOwner = !!me && me.role === "owner" && me.active !== false;
  // 取り消し（オーナーだけ）：行とPDFは残り、「取り消し済み」の印と理由が付く。修正履歴にも残る。元には戻せない
  async function voidDoc(d: ConsentDocument) {
    const reason = prompt(`「${d.template_title}」（${fmtDate(new Date(d.signed_at))}・${d.signer_name} 様）を取り消します。\n書類とPDFは消えず、「取り消し済み」の印が付きます（元には戻せません）。\n\n取り消しの理由を入れてください：`);
    if (reason === null) return;
    try { setMsg(""); await repo.voidConsentDocument(d.id, reason); setMsg("取り消しの印を付けました"); setRev(x => x + 1); }
    catch (e) { setMsg((e as Error).message); }
  }
  // 「保存」：本番の期限つきURLは別ドメインなので download 属性が効かない → Supabase の download 指定を付ける（監査 L5）。ファイル名の日付は日本時間
  const fileName = (d: ConsentDocument) => `${d.template_title}_${ymdJst(new Date(d.signed_at))}.pdf`;
  const dlUrl = (u: string, name: string) => (/^https?:/.test(u) ? `${u}${u.includes("?") ? "&" : "?"}download=${encodeURIComponent(name)}` : u);
  return (
    <div className="card mb-3" data-testid="consent-card">
      <div className="flex flex-wrap items-center gap-2 mb-1">
        <div className="font-bold">同意書・問診票</div>
        {canSign && tpls.length > 0 && <div className="ml-auto flex items-center gap-1">
          {tpls.length > 1 && <select className="inp !min-h-9 text-xs max-w-[12rem]" value={pick} aria-label="書類" onChange={e => setTplId(e.target.value)}>{tpls.map(t => <option key={t.id} value={t.id}>{t.title}</option>)}</select>}
          <button className="btn-primary text-xs !min-h-9 max-sm:!min-h-11" data-testid="consent-start" onClick={() => router.push(`/customers/${customerId}/consent?t=${pick}`)}>同意書を取る{tpls.length === 1 ? `（${tpls[0].title}）` : ""}</button>
        </div>}
        {canSign && tpls.length === 0 && <span className="ml-auto text-xs text-ink-mute">テンプレがありません（設定＞同意書・問診票）</span>}
      </div>
      {docs === undefined ? <div className="text-xs text-ink-mute">読み込み中…</div>
        : docs.length === 0 ? <div className="text-sm text-stone-400">まだ署名した書類はありません</div>
        : <div className="divide-y divide-line">
          {docs.map(d => <div key={d.id} className={`py-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm ${d.voided_at ? "text-ink-mute" : ""}`} data-testid="consent-doc">
            <span className="font-semibold whitespace-nowrap">{fmtDate(new Date(d.signed_at))}</span>
            <span className={d.voided_at ? "line-through" : ""}>{d.template_title}</span>
            <span className="text-xs text-ink-soft">{d.signer_name} 様{(d.signed_by_name || staffName(d.signed_by_staff_id)) ? `／担当 ${d.signed_by_name || staffName(d.signed_by_staff_id)}` : ""}</span>
            {d.voided_at && <span className="chip bg-red-50 border border-red-200 text-red-800" data-testid="consent-voided" title={d.void_reason || ""}>取り消し済み（{fmtDate(new Date(d.voided_at))}{d.void_reason ? `・${d.void_reason}` : ""}）</span>}
            <span className="ml-auto flex gap-1">
              {urls[d.file_path] ? <a className="btn text-xs !min-h-9" href={urls[d.file_path]} target="_blank" rel="noreferrer">開く</a> : <span className="text-xs text-ink-mute">…</span>}
              {urls[d.file_path] && <a className="btn text-xs !min-h-9" href={dlUrl(urls[d.file_path], fileName(d))} download={fileName(d)}>保存</a>}
              {isOwner && !d.voided_at && <button className="btn-quiet text-danger text-xs !min-h-9" data-testid="consent-void" onClick={() => void voidDoc(d)}>取り消す</button>}
            </span>
          </div>)}
        </div>}
      {msg && <div className="text-xs mt-1 text-ink-soft" role="status">{msg}</div>}
      {docs !== undefined && docs.length > 0 && <div className="text-[11px] text-ink-mute mt-1">署名済みの書類は書き換え・削除できません。間違えて取ったものは、オーナーが「取り消す」で印を付けます（書類は残ります）。</div>}
    </div>
  );
}
