import { NextRequest, NextResponse } from "next/server";
import { getSupabaseServerClient } from "@/lib/supabase-server";
import type { SalesRowInsert } from "@/lib/row-mapping";
export const dynamic = "force-dynamic";
const MAX_ROWS_PER_REQUEST = 2000;

// 2026-08-28追加: 「受注番号+受注行番号+品番+数量+単価」が既存の行と同じなのに、
// 納品書番号(または納品書行番号)だけが違う行を検知するための重複候補チェック。
//
// 背景: 取り込み(upsert)は「受注番号+受注行番号+納品書番号+納品書行番号」の
// 4項目が完全一致した行だけを「同じ行」として上書きする。逆に言うと、同じ出荷の
// 内容(商品・数量・単価)がそっくり同じでも、納品書番号だけ新しい番号で基幹システムに
// 登録し直されると、この仕組みでは別の行として素通りしてしまい、売上が二重に
// 計上されてしまう(実際に高松拠点で発生し、sales-dashboardとの売上差額の原因に
// なっていたことが確認されている)。
// 自動で「これは誤りだから消す」と判断するのは危険(取消(マイナス)行とセットで
// 正しく相殺される訂正パターンや、本当に複数回に分けて出荷しただけのケースもあり、
// 機械的に区別できないため)。そのため、ここでは検知して警告するだけにとどめ、
// 削除するかどうかは人が内容を見て判断する。
type DuplicateWarning = {
  order_no: string;
  order_line: string;
  item_code: string | null;
  qty: number | null;
  sell_price: number | null;
  delivery_date: string | null;
  incoming_delivery_note_no: string | null;
  incoming_delivery_note_line: string | null;
  existing_delivery_note_no: string | null;
  existing_delivery_note_line: string | null;
};

const MAX_DUPLICATE_WARNINGS = 50;

async function findDuplicateCandidates(
  supabase: ReturnType<typeof getSupabaseServerClient>,
  rows: SalesRowInsert[]
): Promise<{ warnings: DuplicateWarning[]; totalCandidates: number }> {
  const orderNos = Array.from(new Set(rows.map((r) => r.order_no).filter((v): v is string => !!v)));
  if (orderNos.length === 0) return { warnings: [], totalCandidates: 0 };

  const { data: existing, error } = await supabase
    .from("sales_lines")
    .select("order_no, order_line, item_code, qty, sell_price, delivery_note_no, delivery_note_line, delivery_date")
    .in("order_no", orderNos);

  // 重複チェックが失敗しても、本体の取り込み自体は成功させたいので、
  // ここではエラーを投げずに「チェックできなかった」扱いにする。
  if (error || !existing) return { warnings: [], totalCandidates: 0 };

  const byKey = new Map<
    string,
    { delivery_note_no: string | null; delivery_note_line: string | null }[]
  >();
  for (const e of existing) {
    const key = `${e.order_no}|${e.order_line}|${e.item_code}|${e.qty}|${e.sell_price}`;
    const list = byKey.get(key);
    const entry = { delivery_note_no: e.delivery_note_no, delivery_note_line: e.delivery_note_line };
    if (list) list.push(entry);
    else byKey.set(key, [entry]);
  }

  const warnings: DuplicateWarning[] = [];
  let totalCandidates = 0;
  for (const r of rows) {
    if (!r.order_no || !r.order_line) continue;
    const key = `${r.order_no}|${r.order_line}|${r.item_code}|${r.qty}|${r.sell_price}`;
    const candidates = byKey.get(key);
    if (!candidates) continue;
    for (const c of candidates) {
      const sameNote = c.delivery_note_no === r.delivery_note_no && c.delivery_note_line === r.delivery_note_line;
      if (sameNote) continue; // 自分自身(=今回の上書き対象)は対象外
      totalCandidates++;
      if (warnings.length < MAX_DUPLICATE_WARNINGS) {
        warnings.push({
          order_no: r.order_no,
          order_line: r.order_line,
          item_code: r.item_code,
          qty: r.qty,
          sell_price: r.sell_price,
          delivery_date: r.delivery_date,
          incoming_delivery_note_no: r.delivery_note_no,
          incoming_delivery_note_line: r.delivery_note_line,
          existing_delivery_note_no: c.delivery_note_no,
          existing_delivery_note_line: c.delivery_note_line,
        });
      }
    }
  }
  return { warnings, totalCandidates };
}

export async function POST(req: NextRequest) {
  let body: { rows?: SalesRowInsert[] };
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

  // 重複候補チェックは、上書き前の「既存データ」と突き合わせる必要があるため、
  // upsertより先に行う。
  const { warnings: duplicateWarnings, totalCandidates: duplicateCandidateTotal } = await findDuplicateCandidates(
    supabase,
    rows
  );

  const { error, count } = await supabase
    .from("sales_lines")
    .upsert(rows, {
      onConflict: "order_no,order_line,delivery_note_no,delivery_note_line",
      count: "exact",
    });
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({
    upserted: count ?? rows.length,
    duplicateWarnings,
    duplicateCandidateTotal,
  });
}
