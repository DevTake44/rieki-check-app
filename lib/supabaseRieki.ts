// rieki-check(別のSupabaseプロジェクト)に接続するためのクライアント。
// sales-dashboard自身のDBとは別のプロジェクトなので、専用のURL・キーを使う。
// Vercelの環境変数に RIEKI_SUPABASE_URL / RIEKI_SUPABASE_SERVICE_ROLE_KEY を追加してください
// (rieki-checkのSupabaseダッシュボード → Project Settings → API から取得できます)。

import { createClient } from "@supabase/supabase-js";

export function getRiekiSupabaseClient() {
  const url = process.env.RIEKI_SUPABASE_URL;
  const key = process.env.RIEKI_SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error(
      "rieki-check連携用の環境変数(RIEKI_SUPABASE_URL / RIEKI_SUPABASE_SERVICE_ROLE_KEY)が設定されていません。VercelでこれらをRieki-checkのSupabaseプロジェクトの値に設定してください。"
    );
  }

  return createClient(url, key, {
    auth: { persistSession: false },
    global: {
      // sales-dashboard本体と同じく、キャッシュさせず常に最新データを取得する
      fetch: (input: RequestInfo | URL, init?: RequestInit) =>
        fetch(input, { ...init, cache: "no-store" }),
    },
  });
}
