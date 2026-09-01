import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase-server";
import type { ProductMasterRow } from "@/lib/productMasterTransform";
export const dynamic = "force-dynamic";

// 商品マスタの取り込み。品番(product_code)をキーにupsertするだけの単純な洗い替え。
// 全件洗い替え(削除フラグの立った行も含めてそのまま反映)なので、CSVから消えた行を
// 自動削除する処理は行わない(削除フラグはCSV側で管理されている前提)。
const MAX_ROWS = 20000;

export async function POST(req: NextRequest) {
  let body: { rows?: ProductMasterRow[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "リクエストの形式が不正です(JSONではありません)。" }, { status: 400 });
  }
  const rows = body.rows;
  if (!Array.isArray(rows)) {
    return NextResponse.json({ error: "rows が配列ではありません。" }, { status: 400 });
  }
  if (rows.length === 0) {
    return NextResponse.json({ error: "反映するデータがありません。" }, { status: 400 });
  }
  if (rows.length > MAX_ROWS) {
    return NextResponse.json(
      { error: `対象行数が想定より多すぎます(${rows.length}件 > 上限${MAX_ROWS}件)。` },
      { status: 400 }
    );
  }

  const supabase = getSupabaseServerClient();
  const nowIso = new Date().toISOString();
  const payload = rows.map((r) => ({ ...r, updated_at: nowIso }));

  const { error } = await supabase.from("product_master").upsert(payload, { onConflict: "product_code" });
  if (error) {
    return NextResponse.json({ error: `取り込みに失敗しました: ${error.message}` }, { status: 500 });
  }

  return NextResponse.json({ inserted: rows.length });
}
