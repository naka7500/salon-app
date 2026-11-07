"use client";
// LINE受信箱：お客様から届いた LINE（メッセージ・前日確認のボタン・友だち追加/ブロック）と、送った記録。
// 見るのはスタッフ全員。「対応済み」は閲覧のみ以外。アプリからの返信はしない（返信は LINE Official Account Manager のチャットで）。
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { getRepo, type Customer, type LineLink, type LineMessage, type Staff, type LineSettings } from "@/lib/db";
import { INBOX_EVENT } from "@/components/Nav";

const fmtAt = (iso: string) => new Date(iso).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
const KIND: Record<string, string> = { message: "メッセージ", follow: "友だち追加・連携", unfollow: "ブロック", postback: "前日確認の返事", confirm: "前日確認", revisit: "再来案内", reply: "返事", ack: "自動のお礼", test: "試し送信", optout: "配信停止・再開" };
const needsAction = (m: LineMessage) => m.direction === "in" && !m.handled_at && (m.kind === "message" || (m.kind === "postback" && m.text === "変更したい"));

export default function LineInboxPage() {
  const repo = getRepo();
  const [list, setList] = useState<LineMessage[] | null | undefined>(undefined);
  const [links, setLinks] = useState<LineLink[]>([]);
  const [names, setNames] = useState<Record<string, Customer>>({});
  const [me, setMe] = useState<Staff | null>(null);
  const [settings, setSettings] = useState<LineSettings | null>(null);
  const [tab, setTab] = useState<"todo" | "in" | "all">("todo");
  const [msg, setMsg] = useState("");
  const load = useCallback(async () => {
    const [m, l, s] = await Promise.all([repo.lineMessages(300).catch(() => null), repo.lineLinks().catch(() => null), repo.lineSettings().catch(() => null)]);
    setList(m); setLinks(l || []); setSettings(s);
    const ids = [...new Set([...(m || []).map(x => x.customer_id), ...(l || []).map(x => x.customer_id)].filter(Boolean) as string[])];
    if (ids.length) repo.customersByIds(ids).then(cs => setNames(Object.fromEntries(cs.map(c => [c.id, c])))).catch(() => {});
  }, [repo]);
  useEffect(() => { void Promise.resolve().then(load); repo.me().then(setMe).catch(() => {}); }, [repo, load]);
  const shown = useMemo(() => (list || []).filter(m => (tab === "todo" ? needsAction(m) : tab === "in" ? m.direction === "in" : true)), [list, tab]);
  const who = (m: LineMessage) => { const c = m.customer_id ? names[m.customer_id] : null; const l = links.find(x => x.line_user_id === m.line_user_id); return c?.name || l?.display_name || "（お客様情報と未連携のLINE）"; };
  const canWrite = !me || me.role !== "viewer";
  async function handled(ids: (string | number)[]) { setMsg(""); try { await repo.markLineHandled(ids); await load(); window.dispatchEvent(new Event(INBOX_EVENT)); } catch (e) { setMsg((e as Error).message); } }
  async function iAmThis(u: string | null | undefined) { if (!u) return; setMsg(""); try { await repo.setLineTestTarget(u); setMsg("このLINEを「自分に試し送信」の送り先にしました"); await load(); } catch (e) { setMsg((e as Error).message); } }

  if (list === undefined) return <div className="text-ink-soft">読み込み中…</div>;
  if (list === null) return <div className="card text-sm max-w-2xl">LINE受信箱は準備中です（DB更新 0015 の後に使えます）。いまは LINE未接続 です。</div>;
  const todo = (list || []).filter(needsAction).length;
  return (
    <div className="max-w-4xl" data-testid="line-inbox">
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <h1 className="text-xl font-bold mr-2">LINE受信箱</h1>
        <div className="seg" role="tablist">
          <button role="tab" aria-selected={tab === "todo"} onClick={() => setTab("todo")}>未対応{todo ? ` ${todo}` : ""}</button>
          <button role="tab" aria-selected={tab === "in"} onClick={() => setTab("in")}>届いたもの</button>
          <button role="tab" aria-selected={tab === "all"} onClick={() => setTab("all")}>送ったものも</button>
        </div>
        <span className={`chip ${settings?.enabled ? "bg-emerald-100 text-emerald-900" : "bg-stone-200 text-stone-700"}`}>{settings?.enabled ? "LINE連携：使っています" : "LINE未接続（またはオフ）"}</span>
        <button className="btn-quiet" onClick={load}>更新</button>
        {(me?.role === "owner" || me?.role === "manager") && <Link href="/settings/line" className="btn-quiet">設定</Link>}
      </div>
      <div className="text-xs text-ink-soft mb-2">ここからは返信しません。お返事は LINE Official Account Manager（スマホのLINE公式アカウントアプリ）のチャットで。お返事したら「対応済み」を押してください。</div>
      {msg && <div className="text-sm mb-2 px-3 py-2 rounded bg-moss text-canopy-deep" role="status">{msg}</div>}
      {shown.length === 0 ? <div className="card text-sm text-ink-soft">{tab === "todo" ? "未対応はありません。" : "まだありません。"}</div> : (
        <div className="space-y-2">
          {shown.map(m => (
            <div key={String(m.id)} className={`card !p-3 ${m.direction === "out" ? "bg-paper" : needsAction(m) ? "border-sun" : ""}`} data-testid="line-msg-row">
              <div className="flex flex-wrap items-center gap-2 text-xs text-ink-soft">
                <span className={`chip ${m.direction === "in" ? "bg-moss text-canopy-deep" : "bg-sky-100 text-sky-900"}`}>{m.direction === "in" ? "届いた" : "送った"}・{KIND[m.kind] || m.kind}</span>
                <span className="font-semibold text-ink text-sm">{who(m)}</span>
                <span>{fmtAt(m.created_at)}</span>
                {m.status === "demo" && <span className="chip bg-sky-100 text-sky-900">デモ（送っていない）</span>}
                {m.status === "failed" && <span className="chip bg-rose-100 text-rose-800">失敗</span>}
                {m.handled_at && <span className="chip bg-stone-100 text-stone-700">対応済み（{m.handled_by_name || ""}）</span>}
                <span className="ml-auto flex gap-1">
                  {m.customer_id && <Link className="btn !min-h-8 text-xs" href={`/customers/${m.customer_id}`}>カルテ</Link>}
                  {me?.role === "owner" && m.direction === "in" && m.line_user_id && settings?.test_line_user_id !== m.line_user_id && <button className="btn !min-h-8 text-xs" onClick={() => iAmThis(m.line_user_id)} title="オーナー自身のLINEなら、試し送信の送り先にします">これは自分</button>}
                  {canWrite && needsAction(m) && <button className="btn !min-h-8 text-xs" onClick={() => handled([m.id])} data-testid="line-handled">対応済み</button>}
                </span>
              </div>
              {m.text && <div className="mt-1 text-sm whitespace-pre-wrap">{m.text}</div>}
              {m.error && m.direction === "out" && <div className="text-[11px] text-ink-mute mt-0.5">{m.error}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
