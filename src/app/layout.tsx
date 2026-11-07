import type { Metadata, Viewport } from "next";
import "./globals.css";
import AppShell from "@/components/AppShell";

export const metadata: Metadata = {
  title: "サロン台帳",
  description: "自社予約・POS統合アプリ",
  manifest: "/manifest.json",
  // iPhone の「ホーム画面に追加」で、アプリのように開く（アイコンは app/apple-icon.png）
  appleWebApp: { capable: true, title: "サロン台帳", statusBarStyle: "default" },
};
export const viewport: Viewport = { themeColor: "#22483a", width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="ja" className="h-full antialiased">
      <body className="min-h-full flex flex-col bg-paper text-ink">
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
