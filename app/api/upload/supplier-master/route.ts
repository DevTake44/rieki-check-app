import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase-server";
import type { SupplierMasterRow } from "@/lib/supplierMasterTransform";
export const dynamic = "force-dynamic";

// 仕入先マスタの取り込み。仕入先コード(supplier_code)をキーにupsertする単純な洗い替え。
const MAX_ROWS = 20000;

export async function POST(req: NextRequest) {
  let body: { rows?: SupplierMasterRow[] };
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

  const { error } = await supabase.from("supplier_master").upsert(payload, { onConflict: "supplier_code" });
  if (error) {
    return NextResponse.json({ error: `取り込みに失敗しました: ${error.message}` }, { status: 500 });
  }

  return NextResponse.json({ inserted: rows.length });
}
