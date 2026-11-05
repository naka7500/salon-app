// 背景テンプレの並べ方と、保存したページ ⇔ 手書き画面のページの変換
import type { KarteBackground, KartePage, KartePageBg } from "@/lib/db";
import { builtinByKey, builtinOrder, type BuiltinTemplate } from "@/lib/karteTemplates";
import type { EditorPage } from "./HandwritingEditor";

/** 出す標準の背景（業態で並べ替え・設定で「出さない」にした物は除く・名前の上書き） */
export function visibleBuiltins(rows: KarteBackground[] | null | undefined, businessType?: string): BuiltinTemplate[] {
  const by = new Map((rows || []).filter(r => r.builtin_key).map(r => [r.builtin_key!, r]));
  return builtinOrder(businessType).map(k => builtinByKey(k)).filter((t): t is BuiltinTemplate => !!t && by.get(t.key)?.active !== false)
    .map(t => ({ ...t, name: by.get(t.key)?.name || t.name }));
}

export function pageBg(p: KartePage): KartePageBg {
  if (p.background_path) return { kind: "photo", path: p.background_path };
  if (p.background_template_id) return { kind: "template", id: p.background_template_id };
  if (p.background_builtin) return { kind: "builtin", key: p.background_builtin };
  return { kind: "none" };
}
export const pageToEditor = (p: KartePage): EditorPage => ({ id: p.id, ink: p.strokes, bg: pageBg(p), opacity: Number(p.background_opacity) || 1 });
