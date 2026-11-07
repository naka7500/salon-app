// LINE連携（0015）の型。秘密（チャネルシークレット・アクセストークン）はここに出てこない（サーバだけが扱う）。
import type { ID } from "@/lib/db/types";

export type LineTemplateKey = "confirm" | "revisit" | "ok_reply" | "change_reply" | "ack";
export type LineTemplates = Record<LineTemplateKey, string>;

/** 店舗ごとの LINE 設定（line_channels）。secret_set_at・token_set_at は「保存したか」だけ（中身は読めない） */
export interface LineSettings {
  store_id: ID;
  enabled: boolean;
  channel_id?: string | null; login_channel_id?: string | null; liff_id?: string | null;
  bot_basic_id?: string | null; bot_name?: string | null;
  secret_set_at?: string | null; token_set_at?: string | null;
  confirm_enabled: boolean; confirm_time: string;
  revisit_enabled: boolean; revisit_time: string; revisit_vacancy_only: boolean; vacancy_threshold: number;
  ack_enabled: boolean;
  templates: Partial<LineTemplates>;
  plan_limit: number;
  test_line_user_id?: string | null;
  quota_value?: number | null; quota_usage?: number | null; quota_checked_at?: string | null;
  last_test_at?: string | null; last_test_result?: string | null;
  updated_at?: string;
}
export type LineSettingsPatch = Partial<Pick<LineSettings, "enabled" | "channel_id" | "login_channel_id" | "liff_id" | "confirm_enabled" | "confirm_time" | "revisit_enabled" | "revisit_time" | "revisit_vacancy_only" | "vacancy_threshold" | "ack_enabled" | "templates" | "plan_limit">>;

export const defaultLineSettings = (store_id: ID): LineSettings => ({
  store_id, enabled: false, confirm_enabled: false, confirm_time: "18:00", revisit_enabled: false, revisit_time: "11:00",
  revisit_vacancy_only: false, vacancy_threshold: 50, ack_enabled: false, templates: {}, plan_limit: 200,
});
/** 秘密が両方保存されているか */
export const lineCredentialsSet = (s: Pick<LineSettings, "secret_set_at" | "token_set_at"> | null | undefined) => !!s?.secret_set_at && !!s?.token_set_at;

export interface LineLink {
  id: ID; store_id: ID; customer_id?: ID | null; line_user_id: string; display_name?: string | null;
  followed: boolean; opted_out: boolean; opt_out_reason?: "unfollow" | "customer" | "staff" | null;
  opted_out_at?: string | null; linked_at?: string | null; followed_at?: string | null; unfollowed_at?: string | null;
  created_at?: string; updated_at?: string;
}
/** 送ってよいつながりか（友だち・お知らせ停止していない） */
export const linkSendable = (l: LineLink | null | undefined) => !!l && l.followed && !l.opted_out;

export type LineMessageKind = "message" | "follow" | "unfollow" | "postback" | "confirm" | "revisit" | "reply" | "ack" | "test" | "optout" | "manual";
export interface LineMessage {
  id: ID | number; store_id: ID; line_user_id?: string | null; customer_id?: ID | null; booking_id?: ID | null;
  direction: "in" | "out"; kind: LineMessageKind | string; text?: string | null;
  status: "received" | "sent" | "failed" | "demo" | "skipped"; counted: boolean; error?: string | null; event_id?: string | null;
  handled_at?: string | null; handled_by_name?: string | null; created_at: string;
}
export type LineQueueKind = "confirm" | "revisit" | "test";
export interface LineQueueItem {
  id: ID; store_id: ID; kind: LineQueueKind; dedupe_key: string; booking_id?: ID | null; customer_id?: ID | null; line_user_id: string;
  payload: { messages: LineOutMessage[]; preview: string };
  status: "queued" | "sending" | "sent" | "failed" | "skipped"; attempts: number; error?: string | null;
  scheduled_at?: string; sent_at?: string | null; created_at: string;
}

// ---- LINE に送る形（Messaging API）。使うのは text と flex だけ ----
export type LineOutMessage =
  | { type: "text"; text: string }
  | { type: "flex"; altText: string; contents: Record<string, unknown> };

/** 前日確認のボタンの中身（postback.data） */
export type ConfirmAnswer = "ok" | "change";
