// LINE のつながりを作る・付け替える（会計のQR・LINE予約の新規のお客様・確認待ちの承認で共通）。
// 本番（server.ts）・デモ（memory.ts）・テスト（偽の IO と送信）で同じ動きにするため、DB と LINE の API は外から渡す。
//  ・別の LINE に付け替えたら、前の LINE が友だちのまま・お知らせ停止でなければ「送り先が変わりました」を1通送る（通数に数える。上限なら送らない）
//  ・監査ログ（ID だけ。名前・電話・メール・LINEの表示名・LINEのユーザーIDは書かない）
import type { LineSender } from "./engine";
import type { LineLink, LineMessage } from "./types";
import { mergeLinkedVia, repointNoticeText, REPOINT_NOTICE_KIND, shouldNotifyOld, type LinkAuditAction, type LinkedVia } from "./linkPolicy";

export interface LinkApplyIO {
  linkOfCustomer(customerId: string): Promise<LineLink | null>;
  linkByUser(lineUserId: string): Promise<LineLink | null>;
  saveLink(l: Partial<LineLink> & { line_user_id: string }, opts?: { takeOver?: boolean }): Promise<LineLink>;
  logMessage(m: Omit<LineMessage, "id" | "created_at">): Promise<void>;
  monthCount(): Promise<number>;
  audit(action: LinkAuditAction, after: Record<string, string | number | boolean | null>): Promise<void>;
}
export type NoticeResult = "sent" | "demo" | "skipped_quota" | "skipped_not_sendable" | "failed" | null;
export interface ApplyLinkInput {
  storeId: string; storeName: string; planLimit: number;
  lineUserId: string; displayName: string | null; customerId: string; via: LinkedVia;
  /** 同じお客様についている別の LINE を外して付け替えるか（会計のQR・スタッフの承認だけ true） */
  takeOver: boolean;
  logText: string;
  /** 監査ログに足す ID（確認待ち・予約・会社） */
  ids?: Record<string, string | null>;
  now?: Date;
}
export interface ApplyLinkResult { link: LineLink; linkedVia: LinkedVia; repointed: boolean; oldLinkId: string | null; notice: NoticeResult }

export async function applyLink(io: LinkApplyIO, sender: LineSender | null, p: ApplyLinkInput): Promise<ApplyLinkResult> {
  const nowIso = (p.now ?? new Date()).toISOString();
  const old = await io.linkOfCustomer(p.customerId);
  const mine = await io.linkByUser(p.lineUserId);
  // 同じお客様へのつなぎ直しは前の経路より弱くしない
  const linkedVia = mergeLinkedVia(mine?.customer_id === p.customerId ? mine?.linked_via : null, p.via);
  const link = await io.saveLink({ line_user_id: p.lineUserId, customer_id: p.customerId, display_name: p.displayName, linked_at: nowIso, linked_via: linkedVia, needs_confirm: false }, { takeOver: p.takeOver });
  const repointed = !!old && old.line_user_id !== p.lineUserId;
  await io.logMessage({ store_id: p.storeId, line_user_id: p.lineUserId, customer_id: p.customerId, direction: "in", kind: "follow", text: p.logText, status: "received", counted: false } as Omit<LineMessage, "id" | "created_at">);

  let notice: NoticeResult = null;
  if (repointed) {
    if (!shouldNotifyOld(old, p.lineUserId) || !sender) notice = "skipped_not_sendable";
    else {
      const text = repointNoticeText(p.storeName);
      const base = { store_id: p.storeId, line_user_id: old!.line_user_id, customer_id: null, booking_id: null, direction: "out" as const, kind: REPOINT_NOTICE_KIND, text };
      if ((await io.monthCount()) >= p.planLimit) {
        notice = "skipped_quota";
        await io.logMessage({ ...base, status: "skipped", counted: false, error: "今月の通数の上限" } as Omit<LineMessage, "id" | "created_at">).catch(() => {});
      } else {
        try {
          await sender.push(old!.line_user_id, [{ type: "text", text }], globalThis.crypto.randomUUID());
          notice = sender.demo ? "demo" : "sent";
          await io.logMessage({ ...base, status: sender.demo ? "demo" : "sent", counted: !sender.demo } as Omit<LineMessage, "id" | "created_at">);
        } catch (e) {
          notice = "failed";
          await io.logMessage({ ...base, status: "failed", counted: false, error: String((e as Error)?.message || "").slice(0, 300) } as Omit<LineMessage, "id" | "created_at">).catch(() => {});
        }
      }
    }
  }
  await io.audit(repointed ? "link_repoint" : "link_create", {
    store_id: p.storeId, customer_id: p.customerId, link_id: link.id ?? null, old_link_id: repointed ? old!.id ?? null : null, via: linkedVia, notice, ...(p.ids || {}),
  });
  return { link, linkedVia, repointed, oldLinkId: repointed ? old!.id ?? null : null, notice };
}
