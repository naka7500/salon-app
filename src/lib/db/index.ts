import type { Repo } from './types';
import { memoryRepo } from './memory';
export * from './types';
let repo: Repo | null = null;
export function getRepo(): Repo {
  if (repo) return repo;
  if (process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY && process.env.NEXT_PUBLIC_STORE_ID) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    repo = (require('./supabase') as typeof import('./supabase')).supabaseRepo;
  } else repo = memoryRepo;
  return repo;
}
export const yen = (n: number) => '¥' + n.toLocaleString('ja-JP');
export const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; };
export const hm = (iso: string) => { const d = new Date(iso); return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`; };
export const CHANNEL_LABEL: Record<string,string> = { own: '自社', hpb: 'HPB', phone: '電話', walkin: '来店', viator: 'Viator', klook: 'Klook', ikyu: '一休', line: 'LINE', block: 'ブロック' };
export const CHANNEL_COLOR: Record<string,string> = { own: 'bg-emerald-200 border-emerald-500', hpb: 'bg-rose-200 border-rose-500', phone: 'bg-amber-200 border-amber-500', walkin: 'bg-amber-100 border-amber-400', viator: 'bg-sky-200 border-sky-500', klook: 'bg-orange-200 border-orange-500', ikyu: 'bg-violet-200 border-violet-500', line: 'bg-lime-200 border-lime-500', block: 'bg-gray-300 border-gray-500' };
export const STATUS_LABEL: Record<string,string> = { booked: '予約', arrived: '来店', done: '会計済', cancelled: 'キャンセル', noshow: '無断', block: 'ブロック' };
export const PAY_LABEL: Record<string,string> = { cash: '現金', card: 'カード', emoney: '電子マネー', qr: 'QR', gift: 'ギフト券', voucher: '回数券', ota_prepaid: 'OTA先払い', other: 'その他' };
