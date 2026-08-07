import { getSupabaseServerClient } from "@/lib/supabase-server";
import DataStatus, { type TableStatus } from "@/components/DataStatus";

// 常に最新の状態を見せたいページなので、キャッシュさせない。
export const dynamic = "force-dynamic";

// 「直近の取り込み」とみなす時間の幅。バッチアップロード(1000件ずつ分割送信)は
// 大きいファイルでも数分程度で終わることを踏まえ、最終行のcreated_atから
// この幅より前の行は「前回までの取り込み分」とみなして切り分ける。
const BATCH_WINDOW_MINUTES = 30;

type TableConfig = {
  key: string;
  label: string;
  table: string;
  dateColumn: string;
  dateColumnLabel: string;
};

const TABLES: TableConfig[] = [
  { key: "sales", label: "売上データ", table: "sales_lines", dateColumn: "delivery_date", dateColumnLabel: "納品日" },
  { key: "purchase", label: "仕入データ", table: "purchase_lines", dateColumn: "purchase_date", dateColumnLabel: "仕入日" },
  {
    key: "transfer",
    label: "社内間(未納品の拠点間移動)",
    table: "stock_transfer_pending",
    dateColumn: "order_date",
    dateColumnLabel: "受注日",
  },
  {
    key: "shippingNote",
    label: "送り状問合せデータ(運賃照合用)",
    table: "shipping_note_mapping",
    dateColumn: "issue_date",
    dateColumnLabel: "発行日",
  },
];

async function fetchOne(
  supabase: ReturnType<typeof getSupabaseServerClient>,
  table: string,
  column: string,
  ascending: boolean
): Promise<string | null> {
  const { data, error } = await supabase
    .from(table)
    .select(column)
    .not(column, "is", null)
    .order(column, { ascending })
    .limit(1);
  if (error || !data || data.length === 0) return null;
  const row = data[0] as Record<string, unknown>;
  const v = row[column];
  return v === null || v === undefined ? null : String(v);
}

async function fetchStatus(
  supabase: ReturnType<typeof getSupabaseServerClient>,
  cfg: TableConfig
): Promise<TableStatus> {
  const [{ count }, minDate, maxDate, lastImportedAt] = await Promise.all([
    supabase.from(cfg.table).select("*", { count: "exact", head: true }),
    fetchOne(supabase, cfg.table, cfg.dateColumn, true),
    fetchOne(supabase, cfg.table, cfg.dateColumn, false),
    fetchOne(supabase, cfg.table, "created_at", false),
  ]);

  let lastBatchCount: number | null = null;
  let lastBatchMinDate: string | null = null;
  let lastBatchMaxDate: string | null = null;

  if (lastImportedAt) {
    const threshold = new Date(new Date(lastImportedAt).getTime() - BATCH_WINDOW_MINUTES * 60 * 1000).toISOString();
    const { count: batchCount } = await supabase
      .from(cfg.table)
      .select("*", { count: "exact", head: true })
      .gte("created_at", threshold);
    lastBatchCount = batchCount ?? null;

    const [bMin, bMax] = await Promise.all([
      supabase
        .from(cfg.table)
        .select(cfg.dateColumn)
        .gte("created_at", threshold)
        .not(cfg.dateColumn, "is", null)
        .order(cfg.dateColumn, { ascending: true })
        .limit(1),
      supabase
        .from(cfg.table)
        .select(cfg.dateColumn)
        .gte("created_at", threshold)
        .not(cfg.dateColumn, "is", null)
        .order(cfg.dateColumn, { ascending: false })
        .limit(1),
    ]);
    const bMinRow = bMin.data?.[0] as Record<string, unknown> | undefined;
    const bMaxRow = bMax.data?.[0] as Record<string, unknown> | undefined;
    lastBatchMinDate = bMinRow ? String(bMinRow[cfg.dateColumn] ?? "") || null : null;
    lastBatchMaxDate = bMaxRow ? String(bMaxRow[cfg.dateColumn] ?? "") || null : null;
  }

  return {
    key: cfg.key,
    label: cfg.label,
    dateColumnLabel: cfg.dateColumnLabel,
    rowCount: count ?? 0,
    minDate,
    maxDate,
    lastImportedAt,
    lastBatchCount,
    lastBatchMinDate,
    lastBatchMaxDate,
  };
}

export default async function DataStatusPage() {
  const supabase = getSupabaseServerClient();

  let statuses: TableStatus[] = [];
  let errorMessage: string | null = null;
  try {
    statuses = await Promise.all(TABLES.map((cfg) => fetchStatus(supabase, cfg)));
  } catch (e) {
    errorMessage = String(e);
  }

  if (errorMessage) {
    return (
      <div className="page">
        <h1>データ更新状況</h1>
        <div className="card">
          <p>データの取得に失敗しました。</p>
          <pre style={{ whiteSpace: "pre-wrap", color: "#c0392b" }}>{errorMessage}</pre>
        </div>
      </div>
    );
  }

  return <DataStatus statuses={statuses} />;
}
