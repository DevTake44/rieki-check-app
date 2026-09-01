import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "統合DXダッシュボード",
  description: "仕入・売上データの照合・分析ツール一式",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
