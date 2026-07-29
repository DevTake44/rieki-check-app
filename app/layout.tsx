import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "値上げ検知ダッシュボード",
  description: "仕入 値上げ検知ダッシュボード",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
