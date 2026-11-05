"use client";
// お客様用の公開ページ（/r/...）はログイン不要・店舗のヘッダーなし。それ以外は今までどおり（ログイン＋ナビ）。
import { usePathname } from "next/navigation";
import AuthGate from "@/components/AuthGate";
import Nav from "@/components/Nav";

export default function AppShell({ children }: { children: React.ReactNode }) {
  const path = usePathname() || "";
  if (path === "/r" || path.startsWith("/r/")) return <>{children}</>;
  return (
    <AuthGate>
      <Nav />
      <main className="flex-1 p-3 sm:p-5 max-w-7xl w-full mx-auto">{children}</main>
    </AuthGate>
  );
}
