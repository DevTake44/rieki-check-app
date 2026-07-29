import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase-server";
import type { PurchaseRowInsert } from "@/lib/row-mapping";

export const dynamic = "force-dynamic";

const MAX_ROWS_PER_REQUEST = 2000;

export async function POST(req: NextRequest) {
  let body: { rows?: PurchaseRowInsert[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "リクエストの形式が不正です(JSONではありません)。" }, { status: 400 });
  }

  const rows = body.rows;
  if (!Array.isArray(rows) || rows.length === 0) {
    return NextResponse.json({ error: "rows が空です。" }, { status: 400 });
  }
  if (rows.length > MAX_ROWS_PER_REQUEST) {
    return NextResponse.json(
      { error: `1回のリクエストで送信できるのは最大${MAX_ROWS_PER_REQUEST}件です(${rows.length}件送信されました)。` },
      { status: 400 }
    );
  }

  const supabase = getSupabaseServerClient();
  const { error, count } = await supabase
    .from("purchase_lines")
    .upsert(rows, {
      onConflict: "purchase_no,purchase_line",
      count: "exact",
    });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ upserted: count ?? rows.length });
}
