"use client";
// 予約詳細：ネット予約で予約した人が入れた内容が、お客様の登録内容と違うときの印と、条件の「要確認」（0020）。
// 登録内容は自動では変えない（電話番号だけで他人の情報を書き換えられないように）。必要ならスタッフが顧客詳細で直す。
import { useState } from "react";
import type { Booking, Customer } from "@/lib/db";
import { webInputDiffs } from "@/lib/webInput";

export function WebInputDiffBadge({ booking, customer }: { booking: Booking; customer: Customer | null }) {
  const [open, setOpen] = useState(false);
  const diffs = webInputDiffs(booking, customer);
  if (!diffs.length && !booking.web_check) return null;
  return (<>
    {booking.web_check && <div className="mb-2 text-sm px-3 py-2 rounded bg-amber-50 border border-amber-300 text-amber-900" data-testid="web-check">
      <div className="font-semibold">⚠ 要確認：{booking.web_check}</div>
      <div className="text-xs mt-0.5">ネット予約では、来店歴で決まる条件（新規限定・再来限定・○日以内・利用回数）は断らずに受けています（断ると、電話番号がお客様かどうかが外から分かってしまうため）。来店時に確かめて、対象外なら会計で通常の料金にしてください。</div>
    </div>}
    {diffs.length > 0 && <div className="mb-2 text-sm px-3 py-2 rounded bg-amber-50 border border-amber-300 text-amber-900" data-testid="web-input-diff">
      <button type="button" className="font-semibold underline-offset-2 hover:underline text-left" onClick={() => setOpen(v => !v)} aria-expanded={open}>
        ⚠ 予約時の入力が登録内容と違います{open ? "" : "（押すと見られます）"}
      </button>
      {open && <>
        <table className="mt-1 text-xs w-full"><thead><tr className="text-amber-800"><th className="text-left font-normal pr-2">項目</th><th className="text-left font-normal pr-2">予約時の入力</th><th className="text-left font-normal">登録内容</th></tr></thead>
          <tbody>{diffs.map(d => <tr key={d.field}><td className="pr-2 whitespace-nowrap">{d.label}</td><td className="pr-2 break-all">{d.typed}</td><td className="break-all">{d.stored}</td></tr>)}</tbody></table>
        <div className="text-xs mt-1">登録内容は自動では変えていません。ご本人か確かめてから、必要なら顧客詳細で直してください（予約確認メールは予約時の入力のメールに送っています）。</div>
      </>}
    </div>}
  </>);
}
