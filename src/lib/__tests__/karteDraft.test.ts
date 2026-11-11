import { describe, it, expect } from "vitest";
import { draftHasContent, isHeic, HEIC_MSG } from "@/components/karte/ink";

// 監査 2026-11-11 M7：「背景なし・線なし・画像だけ」の手書きページを捨てない
const ink = (n: number) => ({ items: Array.from({ length: n }, () => ({})) });
describe("カルテの手書き：下書きに残すものがあるか", () => {
  it("線も背景も画像も無いページは空", () => {
    expect(draftHasContent({ strokes: ink(0), bg: { kind: "none" } })).toBe(false);
    expect(draftHasContent({ strokes: ink(0), bg: { kind: "none" }, images: [] })).toBe(false);
    expect(draftHasContent({ strokes: ink(0), bg: { kind: "none" }, images: null })).toBe(false);
  });
  it("★画像だけ（背景なし・線なし）のページは残す", () => {
    expect(draftHasContent({ strokes: ink(0), bg: { kind: "none" }, images: [{ id: "i1" }] })).toBe(true);
  });
  it("線がある・背景があるページは残す（今までどおり）", () => {
    expect(draftHasContent({ strokes: ink(1), bg: { kind: "none" } })).toBe(true);
    expect(draftHasContent({ strokes: ink(0), bg: { kind: "builtin" } })).toBe(true);
  });
  it("下書きが複数あるとき、画像だけのページが1枚でもあれば全体を保存する", () => {
    const drafts = [{ strokes: ink(0), bg: { kind: "none" }, images: [] }, { strokes: ink(0), bg: { kind: "none" }, images: [{ id: "i1" }] }];
    expect(drafts.some(draftHasContent)).toBe(true);
  });
});
describe("写真の形式：HEIC の判定", () => {
  it("HEIC／HEIF は種類か拡張子でわかる", () => {
    expect(isHeic({ type: "image/heic", name: "a.heic" })).toBe(true);
    expect(isHeic({ type: "", name: "IMG_0001.HEIC" })).toBe(true);
    expect(isHeic({ type: "image/heif" })).toBe(true);
    expect(isHeic({ type: "image/jpeg", name: "a.jpg" })).toBe(false);
    expect(HEIC_MSG).toMatch(/HEIC/);
  });
});
