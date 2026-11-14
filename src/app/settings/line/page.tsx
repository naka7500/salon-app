"use client";
// 設定＞LINE連携（owner/manager）：店舗ごとの LINE公式アカウント（Messaging API＋LIFF）をつなぐ。
//  ・全部オフで始まる。秘密（チャネルシークレット・アクセストークン）は「書くだけ」（保存後は画面に出さない・読み返せない）
//  ・自動メッセージ（前日確認・再来案内・自動のお礼）はそれぞれオン/オフ。文面は店舗ごとに変えられる（区切り線なし・◆と▶だけ・急がせる言葉なし）
//  ・デモ：LINE には送らずに文面を見せる（友だち追加・ボタン・メッセージ・自動送信をその場で試せる）
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { getRepo, type Store, type Customer, type Booking, type LineSettings, type LineLink, type LineQueueItem, type LineTemplateKey, type LineActionResult, type Menu } from "@/lib/db";
import { DEFAULT_TEMPLATES, TEMPLATE_LABEL, TEMPLATE_VARS, VAR_LABEL, checkTemplate, templateOf, previewText } from "@/lib/line/templates";
import { quotaState, sampleMessages, revisitDays } from "@/lib/line/engine";
import { lineCredentialsSet } from "@/lib/line/types";
import { INBOX_EVENT } from "@/components/Nav";
import { SettingsFrame, useAdmin, Field } from "../SettingsParts";

const fmtAt = (iso?: string | null) => (iso ? new Date(iso).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—");
const KEYS: LineTemplateKey[] = ["confirm", "booked", "revisit", "ok_reply", "change_reply", "ack"];
const Q_LABEL: Record<string, string> = { queued: "送信待ち", sending: "送信中", sent: "送信済み", failed: "失敗", skipped: "見送り" };
const K_LABEL: Record<string, string> = { confirm: "前日確認", revisit: "再来案内", test: "試し送信" };

function Copy({ label, value, testid }: { label: string; value: string; testid?: string }) {
  const [ok, setOk] = useState(false);
  return (
    <div className="text-sm bg-paper border border-line rounded-[var(--radius-ctl)] p-2 break-all" data-testid={testid}>
      <div className="text-xs text-ink-soft mb-0.5">{label}</div>
      <div className="flex items-center gap-2"><code className="flex-1 min-w-0 text-[13px]">{value || "—"}</code>
        {value && <button type="button" className="btn !min-h-8 text-xs" onClick={() => navigator.clipboard?.writeText(value).then(() => { setOk(true); setTimeout(() => setOk(false), 1500); })}>{ok ? "コピーしました" : "コピー"}</button>}</div>
    </div>
  );
}

function Switch({ on, onChange, disabled, label, testid }: { on: boolean; onChange: (v: boolean) => void; disabled?: boolean; label: string; testid?: string }) {
  return (
    <button type="button" role="switch" aria-checked={on} aria-label={label} disabled={disabled} data-testid={testid} onClick={() => onChange(!on)}
      className={`relative inline-flex h-7 w-12 shrink-0 items-center rounded-full transition-colors disabled:opacity-40 ${on ? "bg-canopy" : "bg-line-strong"}`}>
      <span className={`inline-block h-5 w-5 rounded-full bg-white shadow transition-transform ${on ? "translate-x-6" : "translate-x-1"}`} />
    </button>
  );
}

export default function LineSettingsPage() {
  const repo = getRepo();
  const demo = repo.mode === "memory";
  const { me, isAdmin, caps } = useAdmin();
  const [store, setStore] = useState<Store | null>(null);
  const [st, setSt] = useState<LineSettings | null | undefined>(undefined);
  const [f, setF] = useState<Partial<LineSettings>>({});
  const [secret, setSecret] = useState(""); const [token, setToken] = useState("");
  const [usage, setUsage] = useState(0);
  const [queue, setQueue] = useState<LineQueueItem[]>([]);
  const [links, setLinks] = useState<LineLink[]>([]);
  const [menus, setMenus] = useState<Menu[]>([]);
  const [msg, setMsg] = useState(""); const [busy, setBusy] = useState(false);
  const [origin, setOrigin] = useState("");
  const [tplKey, setTplKey] = useState<LineTemplateKey>("confirm");
  const [previews, setPreviews] = useState<LineActionResult["previews"]>([]);
  const ready = !!caps?.v15 && st !== null;

  // keep=true：入力中（未保存）の欄は消さずに、サーバ側で決まる項目（オン/オフ・秘密の保存日時・接続テストの結果）だけ更新
  const load = useCallback(async (keep = false) => {
    const [s, sv, u, q, l] = await Promise.all([repo.store(), repo.lineSettings().catch(() => null), repo.lineMonthUsage().catch(() => 0), repo.lineQueue(50).catch(() => null), repo.lineLinks().catch(() => null)]);
    setStore(s); setSt(sv);
    if (sv) setF(prev => (keep ? { ...prev, enabled: sv.enabled, secret_set_at: sv.secret_set_at, token_set_at: sv.token_set_at, bot_name: sv.bot_name, bot_basic_id: sv.bot_basic_id, last_test_at: sv.last_test_at, last_test_result: sv.last_test_result, test_line_user_id: sv.test_line_user_id, quota_value: sv.quota_value, quota_usage: sv.quota_usage, quota_checked_at: sv.quota_checked_at } : sv));
    setUsage(u); setQueue(q || []); setLinks(l || []);
  }, [repo]);
  useEffect(() => { void Promise.resolve().then(() => { setOrigin(location.origin); return load(); }); repo.menus().then(setMenus).catch(() => {}); }, [repo, load]);

  async function run(fn: () => Promise<unknown>, ok: string | ((r: unknown) => string)) {
    setBusy(true); setMsg("");
    try { const r = await fn(); setMsg(typeof ok === "function" ? ok(r) : ok); await load(true); window.dispatchEvent(new Event(INBOX_EVENT)); }
    catch (e) { setMsg((e as Error).message); } finally { setBusy(false); }
  }
  const credsOk = lineCredentialsSet(st);
  const canEnable = demo || (credsOk && !!st?.channel_id);
  const webhook = store ? `${origin}/api/line/webhook/${store.id}` : "";
  const liffEndpoint = store?.slug ? `${origin}/r/${store.slug}?liff=1` : "";
  const q = quotaState(usage, f.plan_limit ?? 200);
  const tplText = f.templates?.[tplKey] ?? "";
  const effective = templateOf(tplKey, f.templates);
  const check = useMemo(() => checkTemplate(effective, tplKey), [effective, tplKey]);
  const io = store && st ? { store: { id: store.id, name: store.name, phone: store.phone, slug: store.slug, business_type: store.business_type }, settings: { ...st, ...f } as LineSettings, menus } : null;
  const preview = io ? previewText(sampleMessages(io, tplKey, store?.slug ? `${origin}/r/${store.slug}` : null)) : "";
  const EDITABLE = ["channel_id", "login_channel_id", "liff_id", "confirm_enabled", "confirm_time", "revisit_enabled", "revisit_time", "revisit_vacancy_only", "vacancy_threshold", "ack_enabled", "booked_enabled", "plan_limit"] as const;
  const dirty = !!st && (EDITABLE.some(k => (f[k] ?? null) !== (st[k] ?? null)) || JSON.stringify(Object.entries(f.templates || {}).filter(([, v]) => v)) !== JSON.stringify(Object.entries(st.templates || {}).filter(([, v]) => v)));

  async function saveAll() {
    const patch = { enabled: !!f.enabled && canEnable, channel_id: f.channel_id?.trim() || null, login_channel_id: f.login_channel_id?.trim() || null, liff_id: f.liff_id?.trim() || null,
      confirm_enabled: !!f.confirm_enabled, confirm_time: f.confirm_time || "18:00", revisit_enabled: !!f.revisit_enabled, revisit_time: f.revisit_time || "11:00",
      revisit_vacancy_only: !!f.revisit_vacancy_only, vacancy_threshold: Math.max(0, Math.min(100, Math.round(Number(f.vacancy_threshold) || 0))), ack_enabled: !!f.ack_enabled,
      templates: Object.fromEntries(Object.entries(f.templates || {}).filter(([, v]) => v && v.trim())), plan_limit: Math.max(0, Math.round(Number(f.plan_limit) || 0)),
      ...(caps?.v26 ? { booked_enabled: !!f.booked_enabled } : {}) };   // 0026 が無い DB には送らない
    if (patch.channel_id && !/^[0-9]{5,20}$/.test(patch.channel_id)) throw new Error("チャネルIDは数字です（LINE Developers の「チャネル基本設定」）");
    if (patch.login_channel_id && !/^[0-9]{5,20}$/.test(patch.login_channel_id)) throw new Error("LINEログインのチャネルIDは数字です");
    if (patch.liff_id && !/^[0-9]{5,20}-[A-Za-z0-9]{4,20}$/.test(patch.liff_id)) throw new Error("LIFF ID は「1234567890-AbCdEfGh」の形です");
    await repo.saveLineSettings(patch);
  }

  return (
    <SettingsFrame title="設定" isAdmin={isAdmin} notReady={caps && !caps.v15 && "LINE連携は準備中です（DB更新 0015 の後に使えます。Supabase の SQL エディタで 0014 → 0015 の順に流してください）。それまでは「LINE未接続」のままで、何も送られません。"}>
      {st === undefined ? <div className="text-ink-soft">読み込み中…</div> : (
      <div className="space-y-3" data-testid="line-settings">
        {/* 状態 */}
        <div className="card flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <Switch on={!!f.enabled} disabled={!ready || !canEnable || busy} label="LINE連携を使う" testid="line-enabled" onChange={v => run(async () => { setF({ ...f, enabled: v }); await repo.saveLineSettings({ enabled: v && canEnable }); }, v ? "LINE連携をオンにしました（自動メッセージは、下でそれぞれオンにしたものだけ送ります）" : "LINE連携をオフにしました（何も送りません）")} />
            <div>
              <div className="font-bold">LINE連携を使う（この店舗）</div>
              <div className="text-xs text-ink-soft">オフの間は、お客様に何も送りません。{!canEnable && "チャネルID・シークレット・アクセストークンを保存するとオンにできます。"}</div>
            </div>
          </div>
          <span className={`chip ml-auto ${!ready ? "bg-stone-200 text-stone-700" : f.enabled ? "bg-emerald-100 text-emerald-900" : credsOk ? "bg-sun-soft text-[#7a4f12]" : "bg-stone-200 text-stone-700"}`} data-testid="line-status">
            {!ready ? "LINE未接続（準備中）" : f.enabled ? "● 使っています" : credsOk ? "○ つなぐ準備ができています（オフ）" : "LINE未接続"}
          </span>
          {demo && <span className="chip bg-sky-100 text-sky-900">デモ：LINEには送りません（文面を見せるだけ）</span>}
        </div>
        {msg && <div className="text-sm px-3 py-2 rounded-[var(--radius-ctl)] bg-moss text-canopy-deep" role="status" data-testid="line-msg">{msg}</div>}

        <div className="grid lg:grid-cols-2 gap-3">
          {/* チャネル */}
          <div className="card space-y-2">
            <div className="font-bold">1. LINE公式アカウントの情報 <Link href="/settings/line#help" className="text-xs text-canopy underline font-normal">取り方</Link></div>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Messaging API のチャネルID"><input className="inp w-full" inputMode="numeric" autoComplete="off" value={f.channel_id || ""} disabled={!ready} onChange={e => setF({ ...f, channel_id: e.target.value.trim() })} data-testid="line-channel-id" /></Field>
              <Field label="LINEログインのチャネルID（LIFF用）"><input className="inp w-full" inputMode="numeric" autoComplete="off" value={f.login_channel_id || ""} disabled={!ready} onChange={e => setF({ ...f, login_channel_id: e.target.value.trim() })} /></Field>
            </div>
            <Field label="LIFF ID" hint="例 1234567890-AbCdEfGh（LINEログインのチャネル＞LIFF）"><input className="inp w-full" autoComplete="off" value={f.liff_id || ""} disabled={!ready} onChange={e => setF({ ...f, liff_id: e.target.value.trim() })} /></Field>
            <div className="rounded-[var(--radius-ctl)] border border-line p-2 space-y-2" data-testid="line-secrets">
              <div className="text-xs text-ink-soft">秘密の2つは<b>書くだけ</b>です。保存したあとは画面に出ません（サーバだけが使います）。変えるときは新しい値を入れて保存。</div>
              <Field label={`チャネルシークレット ${st?.secret_set_at ? `（保存済み ${fmtAt(st.secret_set_at)}）` : "（未保存）"}`}>
                <input className="inp w-full font-mono" type="password" autoComplete="new-password" name="line-secret-nofill" data-lpignore="true" data-1p-ignore spellCheck={false} placeholder={st?.secret_set_at ? "●●●●（保存済み。変えるときだけ入力）" : "英数字32文字"} value={secret} disabled={!ready} onChange={e => setSecret(e.target.value.trim())} data-testid="line-secret" />
              </Field>
              <Field label={`チャネルアクセストークン（長期） ${st?.token_set_at ? `（保存済み ${fmtAt(st.token_set_at)}）` : "（未保存）"}`}>
                <input className="inp w-full font-mono" type="password" autoComplete="new-password" name="line-secret-nofill" data-lpignore="true" data-1p-ignore spellCheck={false} placeholder={st?.token_set_at ? "●●●●（保存済み。変えるときだけ入力）" : "長い英数字"} value={token} disabled={!ready} onChange={e => setToken(e.target.value.trim())} data-testid="line-token" />
              </Field>
              <div className="flex flex-wrap gap-2">
                <button type="button" className="btn-primary" disabled={!ready || busy || (!secret && !token)} data-testid="line-save-secrets" onClick={() => run(async () => { await repo.saveLineCredentials({ channel_secret: secret || null, access_token: token || null }); setSecret(""); setToken(""); }, "秘密を保存しました（画面には出しません）")}>秘密を保存</button>
                {(st?.secret_set_at || st?.token_set_at) && <button type="button" className="btn text-danger" disabled={busy} onClick={() => { if (confirm("保存した秘密を消しますか？（LINE連携は自動でオフになります）")) void run(() => repo.saveLineCredentials({ channel_secret: "", access_token: "" }), "秘密を消しました（LINE連携はオフ）"); }}>秘密を消す</button>}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" className="btn" disabled={!ready || busy || (!demo && !st?.token_set_at)} data-testid="line-test-connection" onClick={() => run(() => repo.lineAction({ kind: "test_connection" }), r => (r as LineActionResult).message || "")}>接続テスト</button>
              <span className="text-xs text-ink-soft">{st?.last_test_at ? `前回：${fmtAt(st.last_test_at)} ${st.last_test_result || ""}` : "LINE の「/v2/bot/info」をサーバから呼んで、つながるか確かめます"}</span>
            </div>
          </div>

          {/* URL */}
          <div className="card space-y-2">
            <div className="font-bold">2. LINE側に貼るURL</div>
            <Copy label="Webhook URL（Messaging API 設定 ＞ Webhook URL に貼り、「Webhookの利用」をオン）" value={webhook} testid="line-webhook-url" />
            <Copy label="LIFF のエンドポイントURL（LIFF アプリの追加で貼る）" value={liffEndpoint} />
            {!store?.slug && <div className="text-xs text-danger">予約ページのURL名が未設定です（設定＞店舗・ネット予約）。</div>}
            <Copy label="リッチメニュー「予約する」に貼るURL（LIFF ID を保存すると出ます）" value={f.liff_id ? `https://liff.line.me/${f.liff_id}` : ""} />
            <div className="text-xs text-ink-soft pt-1">LINEログインのチャネル（LINE Developers ＞ LINEログイン ＞ チャネル基本設定）に貼るURL。文面は下書きです（要確認：開いて内容を確かめてください）。</div>
            <Copy label="プライバシーポリシーURL（LINE Developers）" value={store?.slug ? `${origin}/r/${store.slug}/privacy` : ""} testid="line-privacy-url" />
            <Copy label="利用規約URL（LINE Developers）" value={store?.slug ? `${origin}/r/${store.slug}/terms` : ""} testid="line-terms-url" />
            <div className="font-bold pt-2">3. 月の通数</div>
            <div className="flex items-end gap-3 flex-wrap">
              <div><div className="text-xs text-ink-soft">今月送った数（前日確認・再来案内・試し送信）</div><div className="text-2xl font-bold tabular-nums" data-testid="line-usage">{usage}<span className="text-sm text-ink-soft font-normal"> / {f.plan_limit ?? 200}通</span></div></div>
              <Field label="プランの上限（通/月）" hint="無料プランの通数は要確認（LINE公式アカウントの料金ページ）"><input type="number" min={0} className="inp w-28 text-right" value={f.plan_limit ?? 200} disabled={!ready} onChange={e => setF({ ...f, plan_limit: +e.target.value })} /></Field>
            </div>
            <div className="h-2 rounded-full bg-line overflow-hidden"><div className={`h-full ${q.level === "stop" ? "bg-danger" : q.level === "warn" ? "bg-sun" : "bg-canopy"}`} style={{ width: `${Math.min(100, q.pct)}%` }} /></div>
            {q.level === "warn" && <div className="text-xs text-[#7a4f12]">上限の80%を超えました。再来案内の数に気をつけてください。</div>}
            {q.level === "stop" && <div className="text-xs text-danger">上限に達しました。再来案内（急がないもの）は止めています。前日確認だけ送ります。</div>}
            {st?.quota_checked_at && <div className="text-xs text-ink-soft">LINE側の数字（接続テスト時）：上限 {st.quota_value ?? "なし"}・今月 {st.quota_usage ?? "—"}通（{fmtAt(st.quota_checked_at)}）</div>}
            <div className="text-[11px] text-ink-mute">返信（ボタンを押した人への返事・自動のお礼）は通数に数えません（LINE の「応答メッセージ」）。要確認。</div>
          </div>
        </div>

        {/* 自動メッセージ */}
        <div className="card space-y-3" data-testid="line-auto">
          <div className="font-bold">4. 自動メッセージ（どれも最初はオフ）</div>
          <div className="rounded-[var(--radius-ctl)] border border-line p-3 space-y-2" data-testid="line-booked">
            <div className="flex items-center gap-2 flex-wrap"><Switch on={!!f.booked_enabled && !!caps?.v26} disabled={!ready || !caps?.v26} label="予約完了のお知らせ" testid="line-booked-enabled" onChange={v => setF({ ...f, booked_enabled: v })} /><b>予約完了のお知らせ</b>
              {!caps?.v26 && <span className="text-xs text-amber-800 bg-amber-100 rounded px-1.5 py-0.5">準備中（DB更新 0026 の後に使えます）</span>}</div>
            <div className="text-xs text-ink-soft">LINEの中から予約が入ったとき、その人の LINE に予約内容（日時・メニュー・店名・予約番号）と、確認・キャンセルのリンクをすぐ1通送ります。同じ予約には1回だけ。1件につき通数を1通使います。月の上限に達したら送りません。友だちでない人・お知らせを止めた人には送りません。既定はオフ。</div>
          </div>
          <div className="grid md:grid-cols-3 gap-3">
            <div className="rounded-[var(--radius-ctl)] border border-line p-3 space-y-2">
              <div className="flex items-center gap-2"><Switch on={!!f.confirm_enabled} disabled={!ready} label="前日確認" testid="line-confirm-enabled" onChange={v => setF({ ...f, confirm_enabled: v })} /><b>前日確認</b></div>
              <div className="text-xs text-ink-soft">明日の予約があって LINE がつながっているお客様へ。ボタン「予定どおり伺います」「変更したい」付き。同じ予約には1回だけ。</div>
              <Field label="送る時刻（日本時間）"><input type="time" className="inp" value={f.confirm_time || "18:00"} disabled={!ready} onChange={e => setF({ ...f, confirm_time: e.target.value })} /></Field>
              {(f.confirm_time || "18:00") > "18:00" && <div className="text-xs text-danger" data-testid="line-confirm-late">！18:00 より後にすると、前日確認は1通も送られません（自動送信が動くのは1日1回・18時台だけのため）。18:00 のままにしてください。</div>}
            </div>
            <div className="rounded-[var(--radius-ctl)] border border-line p-3 space-y-2">
              <div className="flex items-center gap-2"><Switch on={!!f.revisit_enabled} disabled={!ready} label="再来案内" testid="line-revisit-enabled" onChange={v => setF({ ...f, revisit_enabled: v })} /><b>再来案内</b></div>
              <div className="text-xs text-ink-soft">最後の来店からメニューごとの日数が過ぎて、次の予約が無い方へ1回だけ（日数を過ぎて30日のあいだ）。日数は 設定＞メニュー で変えられます。</div>
              <Field label="送る時刻（日本時間）"><input type="time" className="inp" value={f.revisit_time || "11:00"} disabled={!ready} onChange={e => setF({ ...f, revisit_time: e.target.value })} /></Field>
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="w-5 h-5 shrink-0" checked={!!f.revisit_vacancy_only} disabled={!ready} onChange={e => setF({ ...f, revisit_vacancy_only: e.target.checked })} />空き率の高いときだけ案内</label>
              {f.revisit_vacancy_only && <div className="flex items-center gap-1 text-sm">この先2週間の空き率が<input type="number" min={0} max={100} className="inp w-16 text-right" value={f.vacancy_threshold ?? 50} onChange={e => setF({ ...f, vacancy_threshold: +e.target.value })} />%以上のとき</div>}
              <div className="text-[11px] text-ink-mute">日数の目安：{menus.filter(m => m.category === "technical").slice(0, 4).map(m => `${m.short_name || m.name} ${revisitDays(m, store?.business_type)}日`).join("・")}</div>
            </div>
            <div className="rounded-[var(--radius-ctl)] border border-line p-3 space-y-2">
              <div className="flex items-center gap-2"><Switch on={!!f.ack_enabled} disabled={!ready} label="自動のお礼" onChange={v => setF({ ...f, ack_enabled: v })} /><b>メッセージへの自動のお礼</b></div>
              <div className="text-xs text-ink-soft">お客様から LINE が来たとき、短いお礼だけ自動で返します（同じ方へは12時間に1回）。中身への返事はスタッフが。既定はオフ。</div>
              <div className="text-xs text-ink-soft">お客様が「配信停止」と送るとお知らせを止め、「配信再開」で再開します（LINE連携がオンのとき、確認の返事をします）。</div>
            </div>
          </div>
          <div className="text-[11px] text-ink-mute">自動送信は1日1回（毎日18時台）に動きます（Vercel の無料プランの決まり）。18時より後の時刻にしたいとき・何回も動かしたいときは、報告書の「自動送信の回数」を見てください。</div>
        </div>

        {/* 文面 */}
        <div className="card space-y-2" data-testid="line-templates">
          <div className="font-bold">5. 文面（この店舗）</div>
          <div className="text-xs text-ink-soft">決まり：区切り線は使わない／記号は ◆ と ▶ だけ／ていねいに／急がせる言葉（限定・今だけ・残りわずか など）は使わない／予約のリンクは1つだけ。空のまま保存すると標準の文面になります。</div>
          <div className="seg flex-wrap" role="tablist">{KEYS.map(k => <button key={k} role="tab" aria-selected={tplKey === k} onClick={() => setTplKey(k)}>{TEMPLATE_LABEL[k].replace(/（.*）/, "")}</button>)}</div>
          <div className="grid lg:grid-cols-2 gap-3">
            <div>
              <div className="text-xs text-ink-soft mb-1">{TEMPLATE_LABEL[tplKey]}　差し込み：{TEMPLATE_VARS[tplKey].map(v => <button key={v} type="button" className="chip bg-paper border border-line mr-1" onClick={() => setF({ ...f, templates: { ...f.templates, [tplKey]: `${tplText || DEFAULT_TEMPLATES[tplKey]}{${v}}` } })}>{`{${v}}`}＝{VAR_LABEL[v]}</button>)}</div>
              <textarea autoComplete="off" className="inp w-full h-56 font-sans leading-relaxed" value={tplText || DEFAULT_TEMPLATES[tplKey]} disabled={!ready} onChange={e => setF({ ...f, templates: { ...f.templates, [tplKey]: e.target.value === DEFAULT_TEMPLATES[tplKey] ? "" : e.target.value } })} data-testid="line-template-text" />
              {check.errors.map(e => <div key={e} className="text-xs text-danger">✕ {e}</div>)}
              {check.warnings.map(e => <div key={e} className="text-xs text-[#7a4f12]">！ {e}</div>)}
              <div className="flex gap-2 mt-1">{tplText && <button type="button" className="btn text-xs" onClick={() => setF({ ...f, templates: { ...f.templates, [tplKey]: "" } })}>標準の文面に戻す</button>}</div>
            </div>
            <div>
              <div className="text-xs text-ink-soft mb-1">プレビュー（見本のお名前・明日の予約）</div>
              <div className="rounded-xl bg-[#8cabd9] p-3 min-h-56"><div className="bg-white rounded-2xl rounded-tl-sm px-3 py-2 text-sm whitespace-pre-wrap shadow-sm max-w-[22rem]" data-testid="line-preview">{preview}</div></div>
              <div className="flex flex-wrap items-center gap-2 mt-2">
                <button type="button" className="btn" disabled={!ready || busy || me?.role !== "owner" || (!demo && (!credsOk || !st?.test_line_user_id))} data-testid="line-test-send"
                  onClick={() => run(async () => { const r = await repo.lineAction({ kind: "test_send", template: tplKey }); setPreviews(r.previews || []); return r; }, r => (r as LineActionResult).message || "")}>{demo ? "自分に試し送信（デモ＝文面を表示）" : "自分に試し送信"}</button>
                <span className="text-[11px] text-ink-mute">{me?.role !== "owner" ? "試し送信はオーナーだけ" : !demo && !st?.test_line_user_id ? "送り先：LINE受信箱で自分のメッセージの「これは自分」を押すと決まります" : "保存前の文面は試せません（先に保存）"}</span>
              </div>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2 sticky bottom-2 z-10">
          <button type="button" className="btn-primary" disabled={!ready || busy || check.errors.length > 0} data-testid="line-save" onClick={() => run(saveAll, "保存しました")}>設定と文面を保存</button>
          {dirty && <span className="text-xs text-[#7a4f12]">保存していない変更があります</span>}
        </div>

        {/* デモ */}
        {demo && ready && <DemoPanel links={links} onRun={(a, ok) => run(async () => { const r = await repo.lineAction(a); setPreviews(r.previews || []); return r; }, r => (r as LineActionResult).message || ok)} busy={busy} />}
        {previews && previews.length > 0 && (
          <div className="card" data-testid="line-demo-previews">
            <div className="font-bold mb-2">送る文面（{demo ? "デモ：LINEには送っていません" : "送りました"}）</div>
            <div className="grid md:grid-cols-2 gap-2">{previews.map((p, i) => <div key={i} className="rounded-xl bg-[#8cabd9] p-2"><div className="text-[11px] text-white mb-1">宛先：{p.to}（{p.kind}）</div><div className="bg-white rounded-2xl rounded-tl-sm px-3 py-2 text-sm whitespace-pre-wrap">{p.text}</div></div>)}</div>
          </div>
        )}

        {/* 送信の記録 */}
        <div className="card">
          <div className="font-bold mb-2">送信の記録（新しい順・50件）</div>
          {queue.length === 0 ? <div className="text-sm text-ink-soft">まだありません。</div> : (
            <div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr><th className="th">作成</th><th className="th">種類</th><th className="th">状態</th><th className="th">内容</th></tr></thead>
              <tbody>{queue.map(x => <tr key={x.id}><td className="td whitespace-nowrap">{fmtAt(x.created_at)}</td><td className="td whitespace-nowrap">{K_LABEL[x.kind] || x.kind}</td><td className="td whitespace-nowrap">{Q_LABEL[x.status]}{x.error ? <div className="text-[11px] text-ink-mute">{x.error}</div> : null}</td><td className="td text-xs text-ink-soft max-w-[28rem] truncate">{x.payload.preview.split("\n")[0]}…</td></tr>)}</tbody></table></div>
          )}
        </div>

        <div className="card text-sm leading-relaxed" id="help">
          <div className="font-bold mb-1">つなぎ方（くわしくは docs/LINE連携_設定手順.md）</div>
          <ol className="list-decimal pl-5 space-y-0.5 text-ink-soft">
            <li>店舗ごとに LINE公式アカウントを作る（お客様用。スタッフ連絡用とは別）</li>
            <li>LINE Official Account Manager で Messaging API を有効にする（同じ「プロバイダー」の中に作る）</li>
            <li>LINE Developers でチャネルID・チャネルシークレット・チャネルアクセストークン（長期）を出して、上の1.に貼って保存</li>
            <li>Webhook URL を貼って「Webhookの利用」をオン（「検証」で成功を確認）。応答メッセージ（LINE側の自動応答）はオフ推奨</li>
            <li>同じプロバイダーに LINEログインのチャネルを作り、LIFF アプリを追加（エンドポイント＝上のURL・サイズ Full・scope openid profile）。LIFF ID とログインのチャネルIDを貼る</li>
            <li>接続テスト → 受信箱で「これは自分」→ 自分に試し送信 → 問題なければ「LINE連携を使う」をオン → 前日確認などを1つずつオン</li>
          </ol>
          <div className="font-bold mt-3 mb-1">お客様とLINEのつながり方（2026-11-08 オーナー決定・案B）</div>
          <ul className="list-disc pl-5 space-y-0.5 text-ink-soft">
            <li><b>LINEの中からの予約</b>：LINE のアカウント（ユーザーID）がそのお客様の本人です。電話番号では既存のお客様につながず、初めての LINE なら<b>新しいお客様</b>として登録して、その場で LINE がつながります。2回目からは同じお客様に予約が入り、名前・電話・メールは前回の入力が出ます</li>
            <li><b>同じ電話番号のお客様が2人になったとき</b>（例：前はHPB、今回はLINEから予約）：顧客詳細・予約詳細に「同じ電話番号のお客様がいます」と出ます。ご本人と確かめてから<b>「統合する」</b>（オーナー・店長・スタッフ）。自動では統合しません</li>
            <li><b>LINE以外のネット予約（ブラウザ）</b>：電話番号で既存のお客様に予約が入りますが、登録内容は変えません。LINE はつながりません</li>
            <li><b>HPB・電話のお客様</b>：会計の画面・カルテの「LINEでお知らせ（QR）」で、その場でつなぎます（30分・1回だけ）</li>
            <li>新規限定クーポンなど：LINEからの予約で同じ電話番号のお客様がいるときは、予約詳細に「要確認：同じ電話番号のお客様がいます（新規クーポンの対象外の可能性）」と出ます。来店時に確かめて、対象外なら会計で通常の料金にしてください</li>
          </ul>
        </div>
      </div>)}
    </SettingsFrame>
  );
}

function DemoPanel({ links, onRun, busy }: { links: LineLink[]; onRun: (a: Parameters<ReturnType<typeof getRepo>["lineAction"]>[0], ok: string) => void; busy: boolean }) {
  const repo = getRepo();
  const [q, setQ] = useState(""); const [cands, setCands] = useState<Customer[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  const [tomorrow, setTomorrow] = useState<Booking[]>([]);
  const [text, setText] = useState("明日15分ほど遅れそうです");
  useEffect(() => { const t = setTimeout(() => { repo.customers(q, { limit: 8 }).then(setCands).catch(() => {}); }, 200); return () => clearTimeout(t); }, [repo, q]);
  useEffect(() => { const d = new Date(Date.now() + 86400000); const s = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; repo.bookingsOn(s).then(bs => setTomorrow(bs.filter(b => b.customer_id && b.status === "booked"))).catch(() => {}); }, [repo, links]);
  useEffect(() => { const ids = [...new Set([...links.map(l => l.customer_id), ...tomorrow.map(b => b.customer_id)].filter(Boolean) as string[])]; if (ids.length) repo.customersByIds(ids).then(cs => setNames(Object.fromEntries(cs.map(c => [c.id, c.name])))).catch(() => {}); }, [repo, links, tomorrow]);
  const linked = (cid?: string | null) => links.find(l => l.customer_id === cid);
  return (
    <div className="card space-y-3 border-sky-300" data-testid="line-demo">
      <div className="font-bold">デモで試す（LINE には送りません）</div>
      <div className="grid md:grid-cols-3 gap-3 text-sm">
        <div className="space-y-1">
          <div className="text-xs font-semibold text-ink-soft">① お客様が友だち追加・LINE連携した</div>
          <input className="inp w-full" autoComplete="off" placeholder="お客様を検索" value={q} onChange={e => setQ(e.target.value)} />
          <div className="flex flex-wrap gap-1">{cands.slice(0, 6).map(c => <button key={c.id} type="button" className="btn !min-h-8 text-xs" disabled={busy} onClick={() => onRun({ kind: "demo_follow", customer_id: c.id }, "")}>{c.name}{linked(c.id) ? "（連携済み）" : ""}</button>)}</div>
        </div>
        <div className="space-y-1">
          <div className="text-xs font-semibold text-ink-soft">② 明日の予約の前日確認ボタンを押した</div>
          {tomorrow.length === 0 && <div className="text-xs text-ink-mute">明日の予約がありません</div>}
          {tomorrow.slice(0, 6).map(b => <div key={b.id} className="flex items-center gap-1 flex-wrap"><span className="text-xs w-28 truncate">{new Date(b.start_at).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" })} {names[b.customer_id!] || ""}{linked(b.customer_id) ? "" : "（未連携）"}</span>
            <button type="button" className="btn !min-h-8 text-xs" disabled={busy} onClick={() => onRun({ kind: "demo_postback", booking_id: b.id, answer: "ok" }, "")} data-testid="demo-ok">予定どおり</button>
            <button type="button" className="btn !min-h-8 text-xs" disabled={busy} onClick={() => onRun({ kind: "demo_postback", booking_id: b.id, answer: "change" }, "")} data-testid="demo-change">変更したい</button></div>)}
        </div>
        <div className="space-y-1">
          <div className="text-xs font-semibold text-ink-soft">③ メッセージが届いた・ブロックされた</div>
          <input className="inp w-full" autoComplete="off" aria-label="お客様から届くメッセージ（デモ）" value={text} onChange={e => setText(e.target.value)} />
          <div className="flex flex-wrap gap-1">{links.filter(l => l.customer_id).slice(0, 6).map(l => <span key={l.id} className="inline-flex gap-1"><button type="button" className="btn !min-h-8 text-xs" disabled={busy || !text.trim()} onClick={() => onRun({ kind: "demo_message", link_id: l.id, text }, "")}>{names[l.customer_id!] || "お客様"}から</button><button type="button" className="btn !min-h-8 text-xs text-danger" disabled={busy} onClick={() => onRun({ kind: "demo_unfollow", link_id: l.id }, "")} title="ブロック">×</button></span>)}</div>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="btn-primary !whitespace-normal text-left max-w-full" disabled={busy} onClick={() => onRun({ kind: "demo_cron" }, "")} data-testid="demo-cron">テスト送信（デモ）：前日確認・再来案内を今すぐ作る</button>
        <span className="text-xs text-ink-soft">送る時刻を待たずに作り、送る代わりに文面を下に表示します。同じ予約には2回作りません。</span>
      </div>
    </div>
  );
}
