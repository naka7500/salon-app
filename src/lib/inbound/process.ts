// HPBの予約通知メール → 自社の台帳（予約）に反映する処理。本番（/api/inbound/hpb・サービスキー）とデモ（memory.ts）で同じものを使う。
// 方針：HPBはもうお客様を受けているので、空きが無くても断らない（予約は入れて「ダブルブッキングの可能性」の赤い印をつける）。
//       読めないメール・自信のないメールは台帳に入れず「要確認」にする（捨てない）。
import type { Booking, Lane, Menu, Shift, Staff, Store } from "@/lib/db/types";
import { headsAt, laneClosed, type HeadsCtx } from "@/lib/web";
import { applyManualFix, matchKey, mergeHpbConfig, parseHpbMail, HPB_KIND_LABEL, type HpbManualFix, type HpbParsed, type HpbParserOverrides } from "./hpb";

// ---------------------------------------------------------------------------
// 型（0011 の表と同じ形）
// ---------------------------------------------------------------------------
/** 対応表：HPBのクーポン名・メニュー名に pattern が入っていたら → 自社のメニュー（人数）／HPBのスタッフ名 → 自社の担当 */
export interface HpbMapping { id: string; store_id: string; kind: "menu" | "staff"; pattern: string; menu_id?: string | null; people?: number | null; staff_id?: string | null; sort_order: number; active: boolean }
export interface HpbSettings { store_id: string; enabled: boolean; secret_hash?: string | null; secret_set_at?: string | null; plus_address?: string | null; default_menu_id?: string | null; parser_config?: HpbParserOverrides | null; updated_at?: string | null }
/** received＝受け取った直後／done＝取込済／warn＝取込済・要確認（ダブルブッキング・メニュー未対応など）／review＝要確認（台帳に入れていない）／error／ignored＝無視／duplicate＝重複 */
export type InboundStatus = "received" | "done" | "warn" | "review" | "error" | "ignored" | "duplicate";
export const INBOUND_STATUS_LABEL: Record<InboundStatus, string> = { received: "処理中", done: "取込済", warn: "取込済・要確認", review: "要確認（未取込）", error: "エラー", ignored: "無視", duplicate: "重複（何もしない）" };
export interface InboundMail {
  id: string; store_id: string; source: "hpb"; message_id: string; received_at?: string | null; subject: string; body: string; from_address?: string | null;
  parsed?: HpbParsed | null; manual?: HpbManualFix | null; kind?: string | null; reservation_no?: string | null;
  status: InboundStatus; action?: string | null; error?: string | null; booking_id?: string | null; booking_ids?: string[] | null;
  is_test?: boolean; created_at: string; processed_at?: string | null; attempts?: number;
}
export type InboundNotifyKind = "hpb_booking" | "hpb_change" | "hpb_cancel" | "hpb_attention";
/** 予約の印（bookings.alert） */
export const ALERT_DOUBLE = "double_booking";

/** 台帳に書くための口（本番＝サービスキーで Supabase、デモ＝端末内） */
export interface InboundCtx {
  store: Store;
  /** この店の担当（在籍・台帳に表示） */
  staff: Staff[];
  lanes: Lane[];
  /** 使うメニュー（active） */
  menus: Menu[];
  settings: HpbSettings | null;
  mappings: HpbMapping[];
  shiftsOn(date: string): Promise<Shift[]>;
  /** その日のこの店の予約（キャンセル含む・全部） */
  bookingsOn(date: string): Promise<Booking[]>;
  /** この店の HPB 予約で external_ref が一致するもの */
  bookingsByRef(ref: string): Promise<Booking[]>;
  /** 電話（数字だけ）→ カナ＋名前 の順で探す。見つからなければ null */
  findCustomer(phone: string | null, kana: string | null, name: string | null): Promise<string | null>;
  createCustomer(c: { name: string; kana: string | null; phone: string | null }): Promise<string>;
  insertBookings(rows: Omit<Booking, "id" | "created_at" | "updated_at">[]): Promise<Booking[]>;
  updateBooking(id: string, patch: Partial<Booking>): Promise<void>;
  notify(n: { kind: InboundNotifyKind; booking_id: string | null; subject: string; body: string }): Promise<void>;
  newId(): string;
}
/** 受信ログの保存口（本番＝inbound_mails 表、デモ＝端末内） */
export interface InboundIO extends InboundCtx {
  findMail(messageId: string): Promise<InboundMail | null>;
  getMail(id: string): Promise<InboundMail | null>;
  insertMail(m: Omit<InboundMail, "id" | "created_at">): Promise<InboundMail>;
  updateMail(id: string, patch: Partial<InboundMail>): Promise<void>;
}

export interface ApplyOutcome { status: InboundStatus; action: string; error?: string | null; booking_ids: string[]; conflict: boolean; warnings: string[] }

// ---------------------------------------------------------------------------
// 対応表
// ---------------------------------------------------------------------------
export function resolveMenu(p: Pick<HpbParsed, "coupon" | "menu">, menus: Menu[], mappings: HpbMapping[], defaultMenuId?: string | null): { menu: Menu | null; people: number | null; via: "rule" | "auto" | "default" | "none"; rule?: HpbMapping } {
  const hay = matchKey(`${p.coupon || ""} ${p.menu || ""}`);
  const tech = menus.filter(m => m.active !== false && m.category === "technical");
  for (const r of mappings.filter(x => x.kind === "menu" && x.active !== false).sort((a, b) => a.sort_order - b.sort_order)) {
    const k = matchKey(r.pattern); if (!k || !hay.includes(k)) continue;
    const m = menus.find(x => x.id === r.menu_id); if (m) return { menu: m, people: r.people ?? null, via: "rule", rule: r };
  }
  // 自動：自社メニューの名前がクーポン名・メニュー名に入っていれば（長い名前を優先）
  const auto = tech.filter(m => matchKey(m.name).length >= 2 && hay.includes(matchKey(m.name))).sort((a, b) => matchKey(b.name).length - matchKey(a.name).length)[0];
  if (auto) return { menu: auto, people: null, via: "auto" };
  const d = defaultMenuId ? menus.find(m => m.id === defaultMenuId) : undefined;
  if (d) return { menu: d, people: null, via: "default" };
  return { menu: null, people: null, via: "none" };
}
export function resolveStaff(name: string | null, staff: Staff[], mappings: HpbMapping[]): Staff | null {
  if (!name) return null;
  const k = matchKey(name); if (!k) return null;
  for (const r of mappings.filter(x => x.kind === "staff" && x.active !== false).sort((a, b) => a.sort_order - b.sort_order)) {
    const pk = matchKey(r.pattern); if (pk && k.includes(pk)) { const s = staff.find(x => x.id === r.staff_id); if (s) return s; }
  }
  const names = (s: Staff) => [s.name, s.display_name || ""].map(matchKey).filter(x => x.length >= 2);
  return staff.find(s => names(s).some(n => n === k)) || staff.find(s => names(s).some(n => k.includes(n) || n.includes(k))) || null;
}

// ---------------------------------------------------------------------------
// 反映
// ---------------------------------------------------------------------------
const liveB = (b: Booking) => b.status === "booked" || b.status === "arrived" || b.status === "done";
const hmJst = (iso: string) => new Date(iso).toLocaleTimeString("ja-JP", { timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit", hour12: false });
const mdJst = (iso: string) => new Date(iso).toLocaleDateString("ja-JP", { timeZone: "Asia/Tokyo", month: "numeric", day: "numeric" });
const label = (iso: string) => `${mdJst(iso)} ${hmJst(iso)}`;
const canServe = (s: Staff) => s.active !== false && s.show_on_ledger !== false && s.role !== "viewer";

/** 解析結果（＋手で直した値）を台帳に反映する */
export async function applyHpb(ctx: InboundCtx, parsed0: HpbParsed, manual?: HpbManualFix | null): Promise<ApplyOutcome> {
  const p = applyManualFix(parsed0, manual);
  const warnings: string[] = [];
  /** 状態（要確認）には影響しないお知らせ */
  const info: string[] = [];
  const out = (status: InboundStatus, action: string, extra: Partial<ApplyOutcome> = {}): ApplyOutcome => ({ status, action: [action, ...info].join("\n"), booking_ids: [], conflict: false, warnings, ...extra });
  if (p.kind === "unknown") return out("review", "種類（新規・変更・キャンセル）が分からないため、台帳には入れていません");
  if (!p.reservationNo) return out("review", "予約番号が読めないため、台帳には入れていません");
  const ref = p.reservationNo;
  const existing = (await ctx.bookingsByRef(ref)).filter(b => b.status !== "block");
  const live = existing.filter(b => b.status !== "cancelled" && b.status !== "noshow");

  // ---- キャンセル ----
  if (p.kind === "cancel") {
    if (!existing.length) return out("warn", `予約番号 ${ref} の予約が台帳にありません（キャンセルの記録だけ残しました）`);
    if (!live.length) return out("duplicate", `予約番号 ${ref} はすでにキャンセル済みです`, { booking_ids: existing.map(b => b.id) });
    const ids: string[] = []; let done = 0;
    for (const b of live) {
      if (b.status === "done") { done++; continue; }
      await ctx.updateBooking(b.id, { status: "cancelled", alert: null, note: `${b.note ? b.note + "／" : ""}HPBでキャンセル` });
      ids.push(b.id);
    }
    if (done) warnings.push(`会計済みの予約（${done}件）はキャンセルにしていません`);
    const head = live.find(b => b.customer_id) || live[0];
    await ctx.notify({ kind: "hpb_cancel", booking_id: head.id, subject: `【HPBキャンセル】${label(head.start_at)} ${p.name || p.kana || ""}様`, body: `予約番号：${ref}\n日時：${label(head.start_at)}\nHPBでキャンセルされたため、台帳の予約をキャンセルにしました（担当の時間は空きに戻りました）。` });
    return out(done ? "warn" : "done", `キャンセルにしました（${ids.length}件）`, { booking_ids: ids });
  }

  // ---- 新規・変更 ----
  if (!p.date || !p.start || !p.startIso) return out("review", "来店日時が読めないため、台帳には入れていません");
  if (!p.name && !p.kana) return out("review", "お名前が読めないため、台帳には入れていません");
  let kind = p.kind;
  const startMs = new Date(p.startIso).getTime();
  if (kind === "new" && live.length) {
    if (live.some(b => new Date(b.start_at).getTime() === startMs)) return out("duplicate", `予約番号 ${ref} はすでに台帳にあります（同じ日時）`, { booking_ids: live.map(b => b.id) });
    kind = "change"; warnings.push("同じ予約番号の予約がすでにあるため、変更として扱いました");
  }
  if (kind === "change" && !live.length) {
    if (existing.length) return out("warn", `予約番号 ${ref} はキャンセル済みのため、変更は反映していません`, { booking_ids: existing.map(b => b.id) });
    kind = "new"; warnings.push("変更前の予約が台帳に無いため、新しい予約として入れました");
  }

  // メニュー・人数・時間
  const mm = resolveMenu(p, ctx.menus, ctx.mappings, ctx.settings?.default_menu_id);
  const menu = manual?.menu_id ? ctx.menus.find(m => m.id === manual.menu_id) || mm.menu : mm.menu;
  if (!menu) warnings.push(`メニューの対応が見つかりません（「${p.coupon || p.menu || "（クーポン名なし）"}」）。設定＞HPB連携で対応を足してください`);
  else if (mm.via === "default" && !manual?.menu_id) warnings.push(`対応が無いので、いつものメニュー（${menu.name}）にしました`);
  const people = Math.max(1, Math.min(4, manual?.people || mm.people || (p.people > 1 ? p.people : 0) || menu?.people || 1));
  const dur = p.durationMin ?? menu?.duration_min ?? 60;
  if (p.durationMin == null && !menu) warnings.push("施術時間が分からないので60分で入れました");
  const blk = dur + (menu?.interval_min || 0);
  const endIso = new Date(startMs + blk * 60000).toISOString();

  // 空き（人数×部屋）。自分（変更前の予約）は数えない
  const [shifts0, dayBookings] = await Promise.all([ctx.shiftsOn(p.date), ctx.bookingsOn(p.date)]);
  // シフトが1件も無い日：全員出勤とみなして「予約の重なり」と部屋数だけで判断する（シフトを使っていない店で全部が赤くならないように）
  let shifts = shifts0;
  if (!shifts0.some(s => s.staff_id)) {
    shifts = ctx.staff.filter(canServe).map(s => ({ id: `virt-${s.id}`, store_id: ctx.store.id, staff_id: s.id, date: p.date!, kind: "work" as const, start_time: "00:00", end_time: "24:00", is_store_closed: false, break_missed: false }));
    info.push("この日はシフトが入っていないため、予約の重なりと部屋数だけで空きを判断しました");
  }
  const hctx: HeadsCtx = { store: ctx.store, lanes: ctx.lanes, shifts, bookings: dayBookings.filter(b => b.status !== "cancelled"), staff: ctx.staff.filter(canServe), date: p.date, excludeIds: live.map(b => b.id) };
  const h = headsAt(hctx, startMs, dur, blk, { lastOrder: false });
  const reasons: string[] = [];
  if (h.left < people) reasons.push(`空きが足りません（この時間の残り ${h.left}名・必要 ${people}名）`);
  if (laneClosed(hctx, startMs, dur, people)) reasons.push("受付停止（×）の時間です");

  // 担当：指名 → （変更なら今の担当で空いている人）→ 空いている人（予約の少ない順）→ 出勤中の人 → だれか
  const nom = manual?.staff_id ? ctx.staff.find(s => s.id === manual.staff_id) || null : resolveStaff(p.staff, ctx.staff, ctx.mappings);
  if (p.staff && !nom && !manual?.staff_id) warnings.push(`指名スタッフ「${p.staff}」が見つかりません（設定＞HPB連携のスタッフの対応を確認）`);
  const assigned: string[] = [];
  if (nom) { assigned.push(nom.id); if (!h.free.includes(nom.id)) reasons.push(`指名の${nom.name}さんはこの時間あいていません`); }
  for (const b of live) if (b.staff_id && !assigned.includes(b.staff_id) && h.free.includes(b.staff_id) && assigned.length < people) assigned.push(b.staff_id);
  for (const id of h.free) if (assigned.length < people && !assigned.includes(id)) assigned.push(id);
  if (assigned.length < people) {
    const T = (iso: string) => new Date(iso).getTime();
    const overlaps = (sid: string) => dayBookings.filter(b => b.staff_id === sid && liveB(b) && !live.some(x => x.id === b.id) && T(b.start_at) < startMs + blk * 60000 && T(b.end_at) > startMs).length;
    const working = new Set(shifts0.filter(s => s.kind === "work" && s.staff_id).map(s => s.staff_id!));
    const rest = ctx.staff.filter(canServe).filter(s => !assigned.includes(s.id)).sort((a, b) => Number(working.has(b.id)) - Number(working.has(a.id)) || overlaps(a.id) - overlaps(b.id) || (a.sort_order ?? 0) - (b.sort_order ?? 0));
    for (const s of rest) if (assigned.length < people) assigned.push(s.id);
    if (!reasons.length) reasons.push("空いている担当が足りません");
  }
  if (!assigned.length) warnings.push("担当にできるスタッフがいません（設定＞スタッフ）");
  const conflict = reasons.length > 0;

  // お客様
  const display = p.name || p.kana || "HPBのお客様";
  const keepCust = live.find(b => b.customer_id)?.customer_id ?? null;
  let customerId = keepCust;
  if (!customerId) {
    customerId = await ctx.findCustomer(p.phone, p.kana, p.name);
    if (!customerId) customerId = await ctx.createCustomer({ name: display, kana: p.kana, phone: p.phone });
  }

  const staffName = (id?: string | null) => ctx.staff.find(s => s.id === id)?.name || "—";
  const noteBase = [`HPB ${ref}`, p.coupon ? `クーポン：${p.coupon}` : p.menu ? `メニュー：${p.menu}` : "", p.total != null ? `HPB予定金額 ${p.total.toLocaleString()}円` : "", p.request ? `要望：${p.request.replace(/\s+/g, " ").slice(0, 200)}` : ""].filter(Boolean).join("／");
  const alert = conflict ? ALERT_DOUBLE : null;
  const intake = p.request ? [{ label: "HPBのご要望", answer: p.request }] : null;
  const ids: string[] = [];

  if (kind === "new") {
    const grp = people > 1 ? ctx.newId() : null;
    const rows: Omit<Booking, "id" | "created_at" | "updated_at">[] = [];
    for (let k = 0; k < people; k++) rows.push({
      store_id: ctx.store.id, customer_id: k === 0 ? customerId : null, customer_name: k === 0 ? null : `${display}（同行者）`, staff_id: assigned[k] ?? null, lane_id: null,
      start_at: p.startIso, end_at: endIso, status: "booked", channel: "hpb", external_ref: ref, menu_ids: menu ? [menu.id] : [], nominated: k === 0 && !!nom, pair_group: grp,
      note: k === 0 ? noteBase : `HPB ${ref}（同行者）`, price_quote: k === 0 ? p.total : null, intake: k === 0 ? intake : null, alert,
    });
    const made = await ctx.insertBookings(rows);
    ids.push(...made.map(b => b.id));
  } else {
    // 変更：今の行を動かす（履歴は booking_history に自動で残る）。人数が変わったら足す・キャンセルする
    const rows = [...live].sort((a, b) => Number(!!b.customer_id) - Number(!!a.customer_id));
    const prevLabel = label(rows[0].start_at);
    let grp = rows.find(b => b.pair_group)?.pair_group ?? null;
    if (people > 1 && !grp) grp = ctx.newId();
    for (let k = 0; k < rows.length; k++) {
      const b = rows[k];
      if (k >= people) { await ctx.updateBooking(b.id, { status: "cancelled", note: `${b.note || ""}／HPB変更で人数が減ったためキャンセル` }); continue; }
      await ctx.updateBooking(b.id, { start_at: p.startIso, end_at: endIso, staff_id: assigned[k] ?? b.staff_id ?? null, ...(menu ? { menu_ids: [menu.id] } : {}), pair_group: people > 1 ? grp : b.pair_group ?? null, alert,
        ...(k === 0 ? { nominated: !!nom, price_quote: p.total ?? b.price_quote ?? null } : {}), note: `${b.note ? b.note + "／" : ""}HPB変更 ${prevLabel}→${label(p.startIso)}` });
      ids.push(b.id);
    }
    if (people > rows.length) {
      const extra: Omit<Booking, "id" | "created_at" | "updated_at">[] = [];
      for (let k = rows.length; k < people; k++) extra.push({ store_id: ctx.store.id, customer_id: null, customer_name: `${display}（同行者）`, staff_id: assigned[k] ?? null, lane_id: null, start_at: p.startIso, end_at: endIso, status: "booked", channel: "hpb", external_ref: ref, menu_ids: menu ? [menu.id] : [], nominated: false, pair_group: grp, note: `HPB ${ref}（同行者）`, alert });
      ids.push(...(await ctx.insertBookings(extra)).map(b => b.id));
    }
  }

  const who = assigned.slice(0, people).map(staffName).join("・");
  const time = `${label(p.startIso)}〜${hmJst(endIso)}`;
  const kindLabel = kind === "new" ? "新規" : "変更";
  const subj = `【HPB${kindLabel}】${label(p.startIso)} ${display}様${people > 1 ? `（${people}名）` : ""}${conflict ? "　⚠ダブルブッキングの可能性" : ""}`;
  const body = [`予約番号：${ref}`, `日時：${time}`, `お名前：${display}${p.kana && p.kana !== display ? `（${p.kana}）` : ""}`, p.phone ? `電話：${p.phone}` : "", `メニュー：${menu ? menu.name : "（未対応）"}${people > 1 ? `（${people}名）` : ""}`, p.coupon ? `HPBクーポン：${p.coupon}` : "", `担当：${who}${nom ? "（指名）" : ""}`,
    conflict ? `⚠ ${reasons.join("／")}。HPBではもうお客様が予約済みです。台帳で担当・時間を調整し、必要ならお客様に連絡してください。` : "", ...warnings.map(w => `※${w}`)].filter(Boolean).join("\n");
  await ctx.notify({ kind: kind === "new" ? "hpb_booking" : "hpb_change", booking_id: ids[0] ?? null, subject: subj, body });
  if (conflict) warnings.unshift(`ダブルブッキングの可能性：${reasons.join("／")}`);
  const action = `${kindLabel}${kind === "change" ? "（予約を移動）" : ""}：${time}・${who}${people > 1 ? `・${people}名` : ""}${menu ? `・${menu.name}` : ""}`;
  return out(conflict || warnings.length ? "warn" : "done", action, { booking_ids: ids, conflict });
}

// ---------------------------------------------------------------------------
// 受け取り → 解析 → 反映 → 受信ログ（Webhook・再処理・テストメールで共通）
// ---------------------------------------------------------------------------
export interface IngestInput { messageId: string; subject: string; body: string; date?: string | null; from?: string | null; isTest?: boolean }
export interface IngestResult { mail: InboundMail; duplicate: boolean; outcome?: ApplyOutcome }

const MAX_BODY = 60000;
export async function ingestHpbMail(io: InboundIO, input: IngestInput): Promise<IngestResult> {
  const dup = await io.findMail(input.messageId);
  if (dup) return { mail: dup, duplicate: true };
  const parsed = parseHpbMail({ subject: input.subject, body: input.body, date: input.date }, mergeHpbConfig(io.settings?.parser_config));
  const base = { store_id: io.store.id, source: "hpb" as const, message_id: input.messageId, received_at: input.date && !isNaN(Date.parse(input.date)) ? new Date(input.date).toISOString() : new Date().toISOString(),
    subject: (input.subject || "").slice(0, 500), body: (input.body || "").slice(0, MAX_BODY), from_address: input.from?.slice(0, 200) ?? null, parsed, kind: parsed.kind, reservation_no: parsed.reservationNo, is_test: !!input.isTest, attempts: 0, manual: null };
  let mail: InboundMail;
  try { mail = await io.insertMail({ ...base, status: "received" }); }
  catch (e) {
    // 同時に2回届いた（message_id の重複）ときは、先に入った方を返す
    const again = await io.findMail(input.messageId); if (again) return { mail: again, duplicate: true };
    throw e;
  }
  if (io.settings && !io.settings.enabled && !input.isTest) {
    const patch = { status: "ignored" as const, action: "HPB連携がオフのため取り込みませんでした（オンにしてから「再処理」で取り込めます）", processed_at: new Date().toISOString() };
    await io.updateMail(mail.id, patch); return { mail: { ...mail, ...patch }, duplicate: false };
  }
  return processStoredMail(io, mail);
}

/** 保存済みのメールを（もう一度）処理する。manual を渡すと「手で直す」 */
export async function processStoredMail(io: InboundIO, mail: InboundMail, manual?: HpbManualFix | null): Promise<IngestResult> {
  const parsed = parseHpbMail({ subject: mail.subject, body: mail.body, date: mail.received_at }, mergeHpbConfig(io.settings?.parser_config));
  const fix = manual === undefined ? mail.manual ?? null : manual;
  let outcome: ApplyOutcome;
  try {
    const p = applyManualFix(parsed, fix);
    if (!p.ok && !fix) outcome = { status: "review", action: `読み取りに自信がないため、台帳には入れていません（足りない項目：${p.missing.join("・") || "—"}）`, booking_ids: [], conflict: false, warnings: p.warnings };
    else outcome = await applyHpb(io, parsed, fix);
  } catch (e) {
    outcome = { status: "error", action: "処理中にエラーが起きました（「再処理」でもう一度試せます）", error: String((e as Error)?.message || e).slice(0, 500), booking_ids: [], conflict: false, warnings: [] };
  }
  const patch: Partial<InboundMail> = { parsed, manual: fix ?? null, kind: applyManualFix(parsed, fix).kind, reservation_no: applyManualFix(parsed, fix).reservationNo, status: outcome.status,
    action: [outcome.action, ...outcome.warnings.map(w => `※${w}`)].join("\n").slice(0, 2000), error: outcome.error ?? null, booking_id: outcome.booking_ids[0] ?? mail.booking_id ?? null,
    booking_ids: outcome.booking_ids.length ? outcome.booking_ids : mail.booking_ids ?? [], processed_at: new Date().toISOString(), attempts: (mail.attempts ?? 0) + 1 };
  await io.updateMail(mail.id, patch);
  if (outcome.status === "review" || outcome.status === "error") {
    const k = HPB_KIND_LABEL[patch.kind as keyof typeof HPB_KIND_LABEL] || "";
    await io.notify({ kind: "hpb_attention", booking_id: null, subject: `【HPB要確認】${k ? k + "の" : ""}メールを自動で取り込めませんでした`, body: `件名：${mail.subject}\n${outcome.action}${outcome.error ? `\nエラー：${outcome.error}` : ""}\n設定＞HPB連携＞受信ログ で内容を確認し、「手で直す」か「再処理」をしてください。` }).catch(() => {});
  }
  return { mail: { ...mail, ...patch } as InboundMail, duplicate: false, outcome };
}
