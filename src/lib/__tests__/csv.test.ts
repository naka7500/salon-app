import { describe, it, expect } from "vitest";
import { csvCell, csvText } from "@/lib/csv";
describe("M5 CSVの式インジェクション", () => {
  it("= + - @ で始まる文字は ' を付ける", () => {
    expect(csvCell('=HYPERLINK("http://x","a")')).toBe(`"'=HYPERLINK(""http://x"",""a"")"`);
    expect(csvCell("+81")).toBe("'+81"); expect(csvCell("@SUM(A1)")).toBe("'@SUM(A1)"); expect(csvCell("-x")).toBe("'-x");
  });
  it("数値・マイナスの数字はそのまま", () => { expect(csvCell(-26400)).toBe("-26400"); expect(csvCell("-1200")).toBe("-1200"); expect(csvCell("山田")).toBe("山田"); });
  it("BOM と改行", () => expect(csvText([["a", 1], ["b", 2]])).toBe("﻿a,1\r\nb,2"));
});
