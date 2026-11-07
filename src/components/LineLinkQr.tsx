"use client";
// 会計・カルテで出す「LINEでお知らせを受け取る」QR。お客様がスマホのカメラで読む → LINE が開く → ログイン → このお客様とつながる。
// QR の合言葉は30分・1回だけ（サーバでハッシュだけ保存）。つながっている人には「LINE連携済み」を出す。
import { useEffect, useState } from "react";
import { getRepo, type LineLink } from "@/lib/db";

export function useLineLink(customerId?: string | null) {
  const repo = getRepo();
  const [link, setLink] = useState<LineLink | null | undefined>(undefined);
  const [ready, setReady] = useState(false);
  const reload = () => { if (!customerId) { setLink(null); return; } repo.lineLinks([customerId]).then(ls => { setReady(ls !== null); setLink((ls || [])[0] ?? null); }).catch(() => setLink(null)); };
  useEffect(() => { void Promise.resolve().then(reload); }, [customerId]); // eslint-disable-line react-hooks/exhaustive-deps
  return { link, ready, reload };
}

export function LineBadge({ link }: { link: LineLink | null | undefined }) {
  if (!link) return null;
  const ok = link.followed && !link.opted_out;
  return <span className={`chip ${ok ? "bg-[#06c755] text-white" : "bg-stone-200 text-stone-700"}`} data-testid="line-badge">{ok ? "LINE連携済み" : link.opted_out ? "LINE：お知らせ停止" : "LINE：ブロック中"}</span>;
}

export default function LineLinkQr({ customerId, customerName, compact }: { customerId: string; customerName?: string; compact?: boolean }) {
  const repo = getRepo();
  const { link, ready, reload } = useLineLink(customerId);
  const [open, setOpen] = useState(false);
  const [qr, setQr] = useState<{ url: string; img: string; until: number } | null>(null);
  const [err, setErr] = useState("");
  const [left, setLeft] = useState(0);
  useEffect(() => { if (!qr) return; const f = () => setLeft(Math.max(0, Math.round((qr.until - Date.now()) / 1000))); f(); const t = setInterval(f, 1000); return () => clearInterval(t); }, [qr]);
  async function show() {
    setErr(""); setOpen(true); setQr(null);
    try {
      const r = await repo.createLineLinkToken(customerId);
      const QR = await import("qrcode");
      const img = await QR.toDataURL(r.url, { errorCorrectionLevel: "M", margin: 1, width: 320 });
      setQr({ url: r.url, img, until: Date.now() + 30 * 60_000 });
    } catch (e) { setErr((e as Error).message); }
  }
  if (!ready && link === null) return null;            // 0015 未適用（準備中）は出さない
  const ok = !!link && link.followed && !link.opted_out;
  return (
    <>
      <span className="inline-flex items-center gap-1">
        <LineBadge link={link} />
        {!ok && <button type="button" className={`btn ${compact ? "!min-h-8 text-xs max-sm:!min-h-11" : ""}`} onClick={show} data-testid="line-qr-button">LINEでお知らせ（QR）</button>}
      </span>
      {open && (
        <div className="fixed inset-0 bg-black/40 z-[80] flex items-center justify-center p-3" onClick={() => { setOpen(false); reload(); }}>
          <div role="dialog" aria-label="LINEでお知らせを受け取る" className="bg-white rounded-[var(--radius-sheet)] p-4 w-full max-w-sm text-center" onClick={e => e.stopPropagation()} data-testid="line-qr-dialog">
            <div className="font-bold text-lg mb-1">LINEで次回のお知らせを受け取る</div>
            <div className="text-sm text-ink-soft mb-2">{customerName ? `${customerName}様、` : ""}スマホのカメラでこのQRを読んでください。LINEが開いて、前日のご確認などをLINEでお送りできるようになります。</div>
            {err ? <div className="text-sm text-danger my-6">{err}</div> : qr ? <>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={qr.img} alt="LINE連携のQRコード" className="mx-auto w-64 h-64" data-testid="line-qr-img" />
              <div className="text-xs text-ink-soft mt-1">有効期限 あと {Math.floor(left / 60)}分{String(left % 60).padStart(2, "0")}秒・1回だけ使えます</div>
              <div className="text-[11px] text-ink-mute mt-1">読めたら、お客様のLINEで「友だち追加」もしていただくと届きます。</div>
            </> : <div className="text-sm text-ink-soft my-6">作っています…</div>}
            <div className="flex justify-center gap-2 mt-3">
              {qr && <button type="button" className="btn" onClick={show}>作り直す</button>}
              <button type="button" className="btn-primary" onClick={() => { setOpen(false); reload(); }}>閉じる</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/** カルテの「LINE」：連携の状態・QR・お知らせ停止（止める＝スタッフ、再開＝オーナー・店長） */
export function CustomerLineCard({ customerId, customerName }: { customerId: string; customerName: string }) {
  const repo = getRepo();
  const { link, ready, reload } = useLineLink(customerId);
  const [err, setErr] = useState("");
  if (!ready) return null;
  async function opt(v: boolean) { setErr(""); try { await repo.setLineOptOut(link!.id, v); reload(); } catch (e) { setErr((e as Error).message); } }
  return (
    <div className="card mb-3 !p-3 flex flex-wrap items-center gap-2" data-testid="customer-line">
      <span className="font-bold text-sm mr-1">LINE</span>
      {!link && <span className="text-xs text-ink-soft">未連携</span>}
      <LineLinkQr customerId={customerId} customerName={customerName} compact />
      {link && link.followed && !link.opted_out && <button type="button" className="btn !min-h-8 text-xs" onClick={() => { if (confirm("このお客様へのLINEのお知らせ（前日確認・再来案内）を止めますか？")) void opt(true); }} data-testid="line-optout">お知らせを止める</button>}
      {link?.opted_out && link.opt_out_reason !== "unfollow" && <button type="button" className="btn !min-h-8 text-xs" onClick={() => opt(false)}>お知らせを再開（店長以上）</button>}
      {link?.opted_out && <span className="text-[11px] text-ink-mute">{link.opt_out_reason === "customer" ? "お客様が「配信停止」を送りました" : link.opt_out_reason === "unfollow" ? "ブロックされています" : "スタッフが止めました"}</span>}
      {err && <span className="text-xs text-danger">{err}</span>}
    </div>
  );
}
