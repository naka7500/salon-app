import { describe, expect, it } from "vitest";
import { checkSender, parseAuthResults, parseDomainList, fromAddress, randomPlusAddress, isGuessablePlusAddress, DEFAULT_HPB_FROM_DOMAINS } from "../sender";

const GOOD_AR = "mx.google.com;\r\n       dkim=pass header.i=@salonboard.com header.s=s1 header.b=AbCd;\r\n       spf=pass (google.com: domain of bounce@mail.salonboard.com designates 1.2.3.4 as permitted sender) smtp.mailfrom=bounce@mail.salonboard.com;\r\n       dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=salonboard.com";

describe("送り主の確認（S2）", () => {
  it("許可リストのドメイン＋DKIM pass（Gmail の結果）は通る", () => {
    const v = checkSender({ from: "SALON BOARD <yoyaku@salonboard.com>", authResults: GOOD_AR });
    expect(v).toMatchObject({ ok: true, fromDomain: "salonboard.com", authChecked: true });
  });
  it("From が許可リストに無ければ、認証が pass でも拒否", () => {
    const v = checkSender({ from: "攻撃者 <a@evil.example>", authResults: "mx.google.com; dkim=pass header.i=@evil.example; spf=pass smtp.mailfrom=evil.example; dmarc=pass header.from=evil.example" });
    expect(v.ok).toBe(false);
    expect(v.reason).toContain("evil.example");
  });
  it("From を偽装しても、DKIM が別ドメイン・SPF が別ドメインなら拒否", () => {
    const v = checkSender({ from: "<yoyaku@salonboard.com>", authResults: "mx.google.com; dkim=pass header.i=@evil.example; spf=pass (x) smtp.mailfrom=a@evil.example; dmarc=fail (p=NONE) header.from=salonboard.com" });
    expect(v.ok).toBe(false);
  });
  it("DMARC が fail なら拒否・DKIM が fail で SPF も softfail なら拒否", () => {
    expect(checkSender({ from: "x@salonboard.com", authResults: "mx.google.com; dkim=pass header.d=salonboard.com; dmarc=fail header.from=salonboard.com" }).ok).toBe(false);
    expect(checkSender({ from: "x@salonboard.com", authResults: "mx.google.com; dkim=fail header.i=@salonboard.com; spf=softfail smtp.mailfrom=salonboard.com" }).ok).toBe(false);
  });
  it("SPF pass（封筒の送り主が許可リストの中）でも通る・サブドメインも可", () => {
    expect(checkSender({ from: "x@mail.salonboard.com", authResults: "mx.google.com; spf=pass (google.com: …) smtp.mailfrom=bounce@mail.salonboard.com" }).ok).toBe(true);
  });
  it("Gmail 以外が付けた認証結果は信じない", () => {
    expect(checkSender({ from: "x@salonboard.com", authResults: "evil.example; dkim=pass header.i=@salonboard.com" }).ok).toBe(false);
  });
  it("認証結果が無い（古いスクリプト）：既定は拒否、require_auth=false ならドメインだけで通す", () => {
    expect(checkSender({ from: "x@salonboard.com" }).ok).toBe(false);
    expect(checkSender({ from: "x@salonboard.com" }, { requireAuth: false }).ok).toBe(true);
    expect(checkSender({ from: "x@evil.example" }, { requireAuth: false }).ok).toBe(false);
  });
  it("店ごとの許可リストを使う（既定は使わない）", () => {
    const ar = "mx.google.com; dkim=pass header.d=hpb.example.jp";
    expect(checkSender({ from: "n@hpb.example.jp", authResults: ar }, { allowedDomains: ["hpb.example.jp"] }).ok).toBe(true);
    expect(checkSender({ from: "x@salonboard.com", authResults: GOOD_AR }, { allowedDomains: ["hpb.example.jp"] }).ok).toBe(false);
  });
  it("「salonboard.com.evil.example」「evilsalonboard.com」は許可リストに当たらない", () => {
    expect(checkSender({ from: "x@salonboard.com.evil.example" }, { requireAuth: false }).ok).toBe(false);
    expect(checkSender({ from: "x@evilsalonboard.com" }, { requireAuth: false }).ok).toBe(false);
  });
  it("From が読めない・複数の宛先は拒否", () => {
    expect(checkSender({ from: "" }).ok).toBe(false);
    expect(checkSender({ from: "a@salonboard.com, b@evil.example" }, { requireAuth: false }).ok).toBe(false);
  });
  it("拒否理由に本文・名前は入らない（ドメインだけ）", () => {
    const v = checkSender({ from: "山田花子 <hanako@evil.example>" });
    expect(v.reason).not.toContain("hanako");
    expect(v.reason).not.toContain("山田");
  });
});

describe("部品", () => {
  it("parseAuthResults：折り返し・コメントを読める", () => {
    const a = parseAuthResults(GOOD_AR)!;
    expect(a).toMatchObject({ authserv: "mx.google.com", dkimPass: ["salonboard.com"], spf: "pass", spfDomain: "mail.salonboard.com", dmarc: "pass" });
  });
  it("parseDomainList：@・from:・大文字・重複・不正を整える", () => {
    expect(parseDomainList("from:@SalonBoard.com\nbeauty.hotpepper.jp, salonboard.com\nnot a domain\n")).toEqual(["salonboard.com", "beauty.hotpepper.jp"]);
    expect(parseDomainList(null)).toEqual([]);
    expect(DEFAULT_HPB_FROM_DOMAINS.length).toBeGreaterThan(0);
  });
  it("fromAddress", () => {
    expect(fromAddress('"SALON BOARD" <Yoyaku@SalonBoard.com>')).toBe("yoyaku@salonboard.com");
    expect(fromAddress("yoyaku@salonboard.com")).toBe("yoyaku@salonboard.com");
    expect(fromAddress("no address")).toBeNull();
  });
  it("ランダムな受信アドレス：形・毎回ちがう・推測されやすい形の判定", () => {
    const a = randomPlusAddress(), b = randomPlusAddress();
    expect(a).toMatch(/^kokage\.corp\+hpb-[a-z2-9]{12}@gmail\.com$/);
    expect(a).not.toBe(b);
    expect(isGuessablePlusAddress(a, "kokage-gotanda")).toBe(false);
    expect(isGuessablePlusAddress("kokage.corp+hpb-kokage-gotanda@gmail.com", "kokage-gotanda")).toBe(true);
    expect(isGuessablePlusAddress("kokage.corp+hpb-test@gmail.com", "x")).toBe(true);
    expect(isGuessablePlusAddress("kokage.corp@gmail.com", "x")).toBe(true);
  });
});
