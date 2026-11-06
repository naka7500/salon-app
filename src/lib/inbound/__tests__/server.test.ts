import { describe, expect, it } from "vitest";
import { secretMatches, sha256hex, handleWebhook, HttpError } from "../server";

describe("受け口の合言葉", () => {
  const secret = "aaaaaaaa-0000-0000-0000-000000000099.vC_9wti9RHcWfABCDEFGHIJKLMNOPQRSTUVWXYZ012345";
  it("ハッシュが一致すれば通る・違えば通らない", async () => {
    const h = sha256hex(secret);
    // 画面（ブラウザ）の crypto.subtle と同じ16進になる
    const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
    expect(h).toBe([...new Uint8Array(b)].map(x => x.toString(16).padStart(2, "0")).join(""));
    expect(secretMatches(secret, h)).toBe(true);
    expect(secretMatches(secret + "x", h)).toBe(false);
    expect(secretMatches(secret, null)).toBe(false);
    expect(secretMatches(secret, "zz")).toBe(false);
  });
  it("合言葉の形が違うものは DB を見る前に 401", async () => {
    await expect(handleWebhook(null, {})).rejects.toMatchObject({ status: 401 });
    await expect(handleWebhook("short", {})).rejects.toBeInstanceOf(HttpError);
    await expect(handleWebhook("not-a-uuid." + "x".repeat(60), {})).rejects.toMatchObject({ status: 401 });
  });
});
