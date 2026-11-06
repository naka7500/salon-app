import { defineConfig } from "vitest/config";
import path from "node:path";

// 単体テスト（npm test）。画面は使わない計算・読み取りだけをテストする。
export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  test: { include: ["src/**/*.test.ts"], environment: "node" },
});
