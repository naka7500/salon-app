// お金の数え方（会計・レジ締め・売上台帳で共通）
import type { Sale } from "@/lib/db/types";

/** 支払方法ごとの「売上として受け取った額」（現金はお釣りを引く。赤伝はマイナス） */
export function netPayments(s: Sale): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of s.payments) out[p.method] = (out[p.method] || 0) + p.amount;
  const paid = s.payments.reduce((a, p) => a + p.amount, 0);
  const sign = s.total < 0 ? -1 : 1;
  const change = sign * Math.max(0, sign * (paid - s.total));
  if (change && out.cash !== undefined) out.cash -= change;
  return out;
}

/** 現金売上（お釣りを引いた額。赤伝はマイナス） */
export const cashNetOf = (s: Sale) => netPayments(s).cash || 0;
