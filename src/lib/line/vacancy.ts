// 再来案内の「空き率の高い日だけ案内」：この先 days 日の 空き時間 ÷ 出勤時間（月間表示の空き率と同じ数え方）
import type { Booking, Menu, Shift } from "@/lib/db/types";
import { dayStats } from "@/lib/schedule";
import { addDaysStr } from "./engine";

export function vacancyRateOf(from: string, days: number, shifts: Shift[], bookings: Booking[], menus: Menu[]): number | null {
  let work = 0, free = 0;
  for (let i = 0; i < days; i++) { const d = dayStats(addDaysStr(from, i), shifts, bookings, menus); work += d.workMin; free += d.freeMin; }
  return work > 0 ? free / work : null;
}
