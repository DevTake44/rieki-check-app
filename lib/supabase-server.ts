import { createClient } from "@supabase/supabase-js";

/**
 * サーバー側専用のSupabaseクライアント。
 * service_roleキーを使うため、ブラウザ側のコードから呼び出してはいけません
 * (Route HandlerやServer Componentなど、サーバー上でのみ実行されるコードから使います)。
 *
 * fetchに cache: "no-store" を指定しているのは、Vercelのデータキャッシュに
 *古い結果が残ってしまい、実際にはデータを更新したのに画面に反映されない、
 * という事故を防ぐためです。
 */
export function getSupabaseServerClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error("SUPABASE_URL または SUPABASE_SERVICE_ROLE_KEY が設定されていません。");
  }

  return createClient(url, key, {
    auth: { persistSession: false },
    global: {
      fetch: (input, init) => fetch(input, { ...init, cache: "no-store" }),
    },
  });
}
