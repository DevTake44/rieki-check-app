/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // 2026-08-26追加: 全ページが force-dynamic のため、メニュー⇔各ダッシュボードを
  // 行き来するたびに毎回サーバーへ取りに行っていた(=毎回待たされる)。
  // staleTimes を設定すると、Link(next/link)でのクライアント側の画面遷移に限り、
  // 直近に開いたページを一定時間はそのまま再利用できるようになる(値上げ検知・
  // 売上利益のような分析画面では、多少データが古くても実用上問題ないと判断)。
  // dynamic: force-dynamicなページ(このアプリのほぼ全ページ)を、何秒以内の
  //   再訪問なら再取得せず使い回すか。60秒。
  // static: 静的にできるページ用。今のところ該当ページはほぼ無いが念のため。
  experimental: {
    staleTimes: {
      dynamic: 60,
      static: 180,
    },
  },
};

module.exports = nextConfig;
