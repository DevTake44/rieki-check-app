// sales-dashboard(別のSupabaseプロジェクト)に接続するためのクライアント。
// 仕入価格検索が見ているproduct_master・purchases_detail・supplier_masterは
// rieki-check自身のDBではなく、sales-dashboard側のテーブルにあるため専用のURL・キーを使う。
// Vercelの環境変数に SALES_SUPABASE_URL / SALES_SUPABASE_SERVICE_ROLE_KEY を追加してください
// (sales-dashboardのSupabaseダッシュボード → Project Settings → API から取得できます)。

import { createClient } from "@supabase/supabase-js";

export function getSalesDashboardSupabaseClient() {
  const url = process.env.SALES_SUPABASE_URL;
  const key = process.env.SALES_SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error(
      "sales-dashboard連携用の環境変数(SALES_SUPABASE_URL / SALES_SUPABASE_SERVICE_ROLE_KEY)が設定されていません。Vercelでこれらをsales-dashboardのSupabaseプロジェクトの値に設定してください。"
    );
  }

  return createClient(url, key, {
    auth: { persistSession: false },
    global: {
      fetch: (input: RequestInfo | URL, init?: RequestInit) =>
        fetch(input, { ...init, cache: "no-store" }),
    },
  });
}
