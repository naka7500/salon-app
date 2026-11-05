"use client";
// 店舗・ネット予約の設定（owner/manager）：公開URL・電話・ロゴ/写真・キャンセル期限・通知先・事前問診の質問
import { useEffect, useState } from "react";
import Link from "next/link";
import { getRepo, type Store, type IntakeQuestion, type StoreSettingsPatch } from "@/lib/db";
import { DEFAULT_INTAKE } from "@/lib/web";
import { SettingsFrame, useAdmin, Field } from "./SettingsParts";

const TYPE_LABEL: Record<IntakeQuestion["type"], string> = { text: "1行の記入", textarea: "複数行の記入", choice: "1つ選ぶ", multi: "いくつでも選ぶ" };

export default function StoreSettingsPage() {
  const repo = getRepo();
  const { isAdmin, caps } = useAdmin();
  const [store, setStore] = useState<Store | null>(null);
  const [f, setF] = useState<StoreSettingsPatch>({});
  const [qs, setQs] = useState<IntakeQuestion[]>([]);
  const [msg, setMsg] = useState("");
  const [origin, setOrigin] = useState("");
  useEffect(() => { void Promise.resolve().then(() => setOrigin(location.origin)); repo.store().then(s => { setStore(s); setF(pick(s)); setQs(s.intake_questions?.length ? s.intake_questions : DEFAULT_INTAKE[s.business_type] || []); }); }, [repo]);
  const ready = !!caps?.phaseC;
  const v11 = !!caps?.v11;
  const url = f.slug ? `${origin}/r/${f.slug}` : "";
  const set = (k: keyof StoreSettingsPatch, v: unknown) => { setF({ ...f, [k]: v }); setMsg(""); };
  const isDefaultQs = store ? JSON.stringify(qs) === JSON.stringify(DEFAULT_INTAKE[store.business_type]) : true;

  async function save() {
    try {
      if (f.slug && !/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(f.slug)) throw new Error("URLの名前は半角の小文字・数字・ハイフンで3〜40文字にしてください（例 kokage-gotanda）");
      const clean = qs.filter(q => q.label.trim()).map(q => ({ ...q, label: q.label.trim(), options: q.type === "choice" || q.type === "multi" ? (q.options || []).filter(Boolean) : undefined, options_en: q.type === "choice" || q.type === "multi" ? (q.options_en || []).filter(Boolean) : undefined }));
      const patch = Object.fromEntries(Object.entries(f).map(([k, v]) => [k, v === "" ? null : v])) as StoreSettingsPatch;   // 空欄は null（URL名の重複・形式チェックに引っかからないように）
      if (!v11) { delete patch.room_count; delete patch.start_step_min; }
      const s = await repo.updateStoreSettings({ ...patch, intake_questions: isDefaultQs ? null : clean });
      setStore(s); setMsg("保存しました");
    } catch (e) { setMsg((e as Error).message); }
  }
  const upd = (i: number, p: Partial<IntakeQuestion>) => setQs(qs.map((q, j) => (j === i ? { ...q, ...p } : q)));
  const move = (i: number, d: number) => { const a = [...qs]; const j = i + d; if (j < 0 || j >= a.length) return; [a[i], a[j]] = [a[j], a[i]]; setQs(a); };

  return (
    <SettingsFrame title="設定" isAdmin={isAdmin} notReady={caps && !ready && "ネット予約・クーポン・店舗の公開情報は準備中です（DB更新 0007 の後に使えます）。メニューの基本項目（名前・時間・料金など）は今も編集できます。"}>
      {store && (
        <div className="grid lg:grid-cols-2 gap-3">
          <div className="card space-y-3">
            <div className="font-bold">公式ネット予約</div>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="w-5 h-5" checked={!!f.web_booking_enabled} disabled={!ready} onChange={e => set("web_booking_enabled", e.target.checked)} />ネット予約を受け付ける（お客様用ページを公開する）</label>
            <Field label="予約ページのURLの名前（半角小文字・数字・ハイフン）" hint="例：kokage-gotanda／laciel-hakozaki／test-store">
              <input className="inp w-full" value={f.slug || ""} disabled={!ready} onChange={e => set("slug", e.target.value.trim().toLowerCase())} />
            </Field>
            {url && <div className="text-sm bg-stone-50 border rounded p-2 break-all">
              <div className="text-xs text-stone-500 mb-0.5">お客様用のURL（Instagramのプロフィール・LINEのリッチメニューに貼る）</div>
              <a className="text-[#2f6b4f] underline" href={`/r/${f.slug}`} target="_blank" rel="noreferrer">{url}</a>
              <button className="btn text-xs ml-2" onClick={() => navigator.clipboard?.writeText(url).then(() => setMsg("URLをコピーしました"))}>コピー</button>
              {!f.web_booking_enabled && <div className="text-xs text-amber-700 mt-1">※「受け付ける」にチェックを入れて保存するまで、お客様には「準備中」と表示されます。</div>}
            </div>}
            <div className="grid grid-cols-2 gap-2">
              <Field label="店舗の電話（キャンセル期限後の連絡先）"><input className="inp w-full" value={f.phone || ""} disabled={!ready} onChange={e => set("phone", e.target.value)} /></Field>
              <Field label="店舗名（英語）"><input className="inp w-full" value={f.name_en || ""} disabled={!ready} onChange={e => set("name_en", e.target.value)} /></Field>
            </div>
            <Field label="住所"><input className="inp w-full" value={f.address || ""} disabled={!ready} onChange={e => set("address", e.target.value)} /></Field>
            <div className="grid grid-cols-2 gap-2">
              <Field label="ロゴ画像のURL"><input className="inp w-full" placeholder="https://..." value={f.logo_url || ""} disabled={!ready} onChange={e => set("logo_url", e.target.value)} /></Field>
              <Field label="店内写真のURL（ページ上部）"><input className="inp w-full" placeholder="https://..." value={f.photo_url || ""} disabled={!ready} onChange={e => set("photo_url", e.target.value)} /></Field>
            </div>
            <Field label="予約ページのお知らせ（任意）"><textarea className="inp w-full" rows={2} value={f.web_message || ""} disabled={!ready} onChange={e => set("web_message", e.target.value)} /></Field>
          </div>

          <div className="card space-y-3">
            <div className="font-bold">キャンセル・受付のルール</div>
            <div className="flex flex-wrap items-end gap-2 text-sm">
              <span>キャンセル期限：予約日の</span>
              <input type="number" min={0} max={14} className="inp w-16 text-right" value={f.cancel_deadline_days ?? 1} disabled={!ready} onChange={e => set("cancel_deadline_days", Number(e.target.value))} />
              <span>日前の</span>
              <input type="time" step={900} className="inp" value={f.cancel_deadline_time || "18:00"} disabled={!ready} onChange={e => set("cancel_deadline_time", e.target.value)} />
              <span>まで</span>
            </div>
            <div className="text-xs text-stone-500">例：1日前の18:00＝前日18時まではお客様がリンクからキャンセルできる。過ぎたら「お電話ください」と店舗の電話を表示。</div>
            <Field label="キャンセルについての説明（予約ページの確認画面に出す）"><textarea className="inp w-full" rows={2} value={f.cancel_policy || ""} disabled={!ready} onChange={e => set("cancel_policy", e.target.value)} /></Field>
            <div className="grid grid-cols-2 gap-2">
              <Field label="何日先まで予約できるか"><input type="number" min={1} max={180} className="inp w-full" value={f.booking_horizon_days ?? 60} disabled={!ready} onChange={e => set("booking_horizon_days", Number(e.target.value))} /></Field>
              <Field label="今から何分後以降を受けるか"><input type="number" min={0} step={15} className="inp w-full" value={f.booking_lead_min ?? 60} disabled={!ready} onChange={e => set("booking_lead_min", Number(e.target.value))} /></Field>
            </div>
            <Field label="新しいネット予約の通知先メール（店舗）" hint="メール送信サービスをつなぐまでは送られません（予約台帳のバッジで確認できます）"><input type="email" className="inp w-full" value={f.notify_email || ""} disabled={!ready} onChange={e => set("notify_email", e.target.value)} /></Field>
          </div>

          <div className="card space-y-3 lg:col-span-2" data-testid="heads-settings">
            <div className="font-bold">予約の受け方（人数×部屋）{!v11 && <span className="ml-2 text-xs font-normal text-amber-800 bg-amber-100 rounded px-1.5 py-0.5">準備中（DB更新 0009 の後）</span>}</div>
            <div className="text-xs text-stone-500">空きは「その時間に出勤していて空いているスタッフの人数」と「空いている部屋の数」の少ない方で自動で数えます。1名様メニューは1人分、ペア（2名様）メニューは同じ時間に2人分を使います。</div>
            <div className="grid sm:grid-cols-3 gap-2">
              <Field label="部屋（ベッド）の数" hint="空欄＝部屋の数では制限しない"><input type="number" min={1} max={50} className="inp w-full" value={f.room_count ?? ""} disabled={!v11} onChange={e => set("room_count", e.target.value ? Number(e.target.value) : null)} /></Field>
              <Field label="開始時刻の刻み" hint="ネット予約・電話予約で選べる開始時刻（例 30分＝10:00／10:30…）"><select className="inp w-full" value={f.start_step_min ?? 30} disabled={!v11} onChange={e => set("start_step_min", Number(e.target.value))}>{[15, 30, 60].map(n => <option key={n} value={n}>{n}分ごと</option>)}</select></Field>
            </div>
          </div>

          <div className="card lg:col-span-2">
            <div className="flex flex-wrap items-center gap-2 mb-2">
              <div className="font-bold">事前問診の質問</div>
              <span className="text-xs text-stone-500">{isDefaultQs ? `標準テンプレ（${store.business_type === "headspa" ? "ヘッドスパ" : store.business_type === "eyelash" ? "まつげ" : "ヘア"}）を使用中` : "この店舗用に編集済み"}</span>
              <div className="ml-auto flex gap-1">
                <button className="btn text-xs" disabled={!ready} onClick={() => setQs([...qs, { id: `q${Date.now()}`, label: "", type: "text" }])}>＋質問を足す</button>
                <button className="btn text-xs" disabled={!ready} onClick={() => setQs(DEFAULT_INTAKE[store.business_type] || [])}>標準テンプレに戻す</button>
              </div>
            </div>
            <div className="space-y-2">
              {qs.map((q, i) => (
                <div key={q.id} className="border rounded p-2 grid md:grid-cols-[auto_1fr_1fr_auto] gap-2 items-start">
                  <div className="flex md:flex-col gap-1"><button className="btn text-xs" aria-label="上へ" onClick={() => move(i, -1)}>↑</button><button className="btn text-xs" aria-label="下へ" onClick={() => move(i, 1)}>↓</button></div>
                  <div className="space-y-1">
                    <input className="inp w-full" placeholder="質問（日本語）" value={q.label} disabled={!ready} onChange={e => upd(i, { label: e.target.value })} />
                    <input className="inp w-full" placeholder="質問（英語・任意）" value={q.label_en || ""} disabled={!ready} onChange={e => upd(i, { label_en: e.target.value })} />
                  </div>
                  <div className="space-y-1">
                    <div className="flex gap-2 items-center">
                      <select className="inp" value={q.type} disabled={!ready} onChange={e => upd(i, { type: e.target.value as IntakeQuestion["type"] })}>{Object.entries(TYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
                      <label className="text-xs flex items-center gap-1"><input type="checkbox" checked={!!q.required} disabled={!ready} onChange={e => upd(i, { required: e.target.checked })} />必須</label>
                    </div>
                    {(q.type === "choice" || q.type === "multi") && <>
                      <input className="inp w-full" placeholder="選択肢（、で区切る）" value={(q.options || []).join("、")} disabled={!ready} onChange={e => upd(i, { options: e.target.value.split(/[、,]/).map(x => x.trim()) })} />
                      <input className="inp w-full" placeholder="選択肢・英語（, で区切る・任意）" value={(q.options_en || []).join(", ")} disabled={!ready} onChange={e => upd(i, { options_en: e.target.value.split(/[、,]/).map(x => x.trim()) })} />
                    </>}
                  </div>
                  <button className="btn text-xs text-rose-600" disabled={!ready} onClick={() => setQs(qs.filter((_, j) => j !== i))}>削除</button>
                </div>
              ))}
            </div>
            <div className="text-xs text-stone-500 mt-2">回答は予約に保存され、その予約で会計してカルテを書くときに自動で貼られます（カルテ画面にも表示）。健康に関わる内容なので、スタッフ以外には見えません。</div>
          </div>
        </div>
      )}
      <div className="sticky bottom-0 mt-3 py-2 bg-stone-50/95 flex items-center gap-3 border-t">
        <button className="btn-primary" disabled={!ready} onClick={save}>保存する</button>
        {msg && <span className={`text-sm ${msg.includes("しました") ? "text-emerald-700" : "text-rose-600"}`}>{msg}</span>}
        <div className="ml-auto flex gap-2 text-sm"><Link className="underline text-[#2f6b4f]" href="/settings/menus">メニューの設定へ</Link><Link className="underline text-[#2f6b4f]" href="/settings/coupons">クーポンの設定へ</Link></div>
      </div>
    </SettingsFrame>
  );
}

function pick(s: Store): StoreSettingsPatch {
  return { slug: s.slug ?? "", name_en: s.name_en ?? "", phone: s.phone ?? "", address: s.address ?? "", logo_url: s.logo_url ?? "", photo_url: s.photo_url ?? "", web_message: s.web_message ?? "", notify_email: s.notify_email ?? "", cancel_policy: s.cancel_policy ?? "",
    cancel_deadline_days: s.cancel_deadline_days ?? 1, cancel_deadline_time: (s.cancel_deadline_time || "18:00").slice(0, 5), booking_horizon_days: s.booking_horizon_days ?? 60, booking_lead_min: s.booking_lead_min ?? 60, web_booking_enabled: !!s.web_booking_enabled,
    ...(s.start_step_min !== undefined ? { room_count: s.room_count ?? null, start_step_min: s.start_step_min } : {}) };
}
