import type { Metadata, Viewport } from "next";
import "./globals.css";
import AppShell from "@/components/AppShell";

export const metadata: Metadata = {
  title: "サロン台帳",
  description: "自社予約・POS統合アプリ",
  manifest: "/manifest.json",
};
export const viewport: Viewport = { themeColor: "#2f6b4f", width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="ja" className="h-full antialiased">
      <body className="min-h-full flex flex-col bg-stone-50 text-stone-800">
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
