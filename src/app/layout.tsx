import type { Metadata, Viewport } from "next";
import "./globals.css";
import Nav from "@/components/Nav";
import AuthGate from "@/components/AuthGate";

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
        <AuthGate>
          <Nav />
          <main className="flex-1 p-3 sm:p-5 max-w-7xl w-full mx-auto">{children}</main>
        </AuthGate>
      </body>
    </html>
  );
}
