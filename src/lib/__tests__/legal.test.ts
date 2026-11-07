import { describe, it, expect } from "vitest";
import { legalSlugOk, operatorLabel, operatorName, privacyPolicy, termsOfUse, privacyPath, termsPath } from "../legal";

const store = { slug: "laciel-hakozaki", name: "ラシエル箱崎", company_name: "株式会社FLEAR", phone: "092-000-0000" };
const flat = (d: ReturnType<typeof privacyPolicy>) => [d.intro, ...d.sections.flatMap(s => [s.title, ...s.body])].join("\n");

describe("事業者名", () => {
  it("会社名があれば会社名（店舗名）、無ければ店舗名", () => {
    expect(operatorName(store)).toBe("株式会社FLEAR");
    expect(operatorLabel(store)).toBe("株式会社FLEAR（ラシエル箱崎）");
    expect(operatorLabel({ name: "ラシエル箱崎", company_name: null })).toBe("ラシエル箱崎");
    expect(operatorLabel({ name: "ラシエル箱崎", company_name: "  " })).toBe("ラシエル箱崎");
    expect(operatorLabel({ name: "同じ", company_name: "同じ" })).toBe("同じ");
  });
});

describe("プライバシーポリシー", () => {
  const t = flat(privacyPolicy(store));
  it("集める情報・目的・第三者・保存・LINEの止め方・問い合わせ先が入る", () => {
    for (const w of ["お名前・フリガナ", "電話番号・メールアドレス", "ご予約・ご来店の履歴", "LINEのユーザーID・表示名", "リマインド", "法令にもとづく場合を除き", "暗号化", "「配信停止」", "ブロック", "電話：092-000-0000", "株式会社FLEAR（ラシエル箱崎）"]) expect(t).toContain(w);
  });
  it("電話番号が無いときは別の連絡方法を書く", () => {
    const t2 = flat(privacyPolicy({ ...store, phone: null }));
    expect(t2).not.toContain("電話：");
    expect(t2).toContain("公式LINEのメッセージ");
  });
});

describe("利用規約", () => {
  it("店舗名とLINEの止め方が入る", () => {
    const d = termsOfUse(store);
    const t = [d.intro, ...d.sections.flatMap(s => s.body)].join("\n");
    expect(d.title).toBe("利用規約");
    expect(t).toContain("株式会社FLEAR（ラシエル箱崎）");
    expect(t).toContain("「配信停止」");
    expect(t).toContain("プライバシーポリシー");
  });
});

describe("URL", () => {
  it("URL名の形・パス", () => {
    expect(legalSlugOk("laciel-hakozaki")).toBe(true);
    expect(legalSlugOk("../etc")).toBe(false);
    expect(legalSlugOk("")).toBe(false);
    expect(legalSlugOk("ABC")).toBe(false);
    expect(privacyPath("x1")).toBe("/r/x1/privacy");
    expect(termsPath("x1")).toBe("/r/x1/terms");
  });
});
