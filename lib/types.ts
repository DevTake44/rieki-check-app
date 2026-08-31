// public.v_price_increase_alerts ビューの1行の型
export type PriceIncreaseAlert = {
  category: "直送" | "在庫";
  order_no: string | null;
  item_code: string | null;
  item_name: string | null;
  customer_name: string | null;
  supplier_name: string | null;
  branch_code: string | null;
  rep_code: string | null;
  order_date: string | null;
  purchase_date: string | null;
  assumed_cost: number;
  actual_price: number;
  sell_price: number | null;
  qty: number;
  gap: number;
  gap_pct: number | null;
  actual_margin_pct: number | null;
  planned_margin_pct: number | null;
  impact: number;
};

// public.v_internal_transfer_lines ビューの1行の型(社内間金額・確定分)
export type InternalTransferLine = {
  sales_line_id: number;
  branch_code: string | null;
  delivery_date: string | null;
  order_date: string | null;
  arrange_type: string;
  loc_code: string | null;
  loc_name: string | null;
  item_code: string | null;
  item_name: string | null;
  qty: number;
  assumed_cost: number;
  amount: number;
};

// public.v_profit_lines ビューの1行の型のうち、経営マトリクス(月別集計)で
// 使う列だけに絞ったもの(2026-08-31追加)。
//
// 背景: v_profit_by_order は受注番号単位で複数行(納品日が違う場合がある)を
// 合計してしまい、delivery_date も「その受注の中で一番遅い納品日」1つに
// 代表させてしまう。そのため、1つの受注が複数月にまたがって出荷される場合
// (よくある)、経営マトリクスの月別列では実際には別の月の売上のはずの金額まで
// 一番最後の月にまとめて計上されてしまう不具合があった(受注番号610023464の例:
// 4月・5月・6月の3回に分けて出荷されているのに、v_profit_by_orderの
// delivery_dateは最終出荷日の6月30日1つに代表され、4・5月分の売上(合計15万6千円)
// まで6月の実績として表示されてしまっていた。年間合計・受注番号単位の一覧は
// 正しいまま、月別の内訳だけが実態とズレる)。
// 経営マトリクスだけは、受注番号単位ではなく実際の行(sales_line)単位の
// delivery_dateを使って月別集計するために、この型・専用のAPI
// (/api/profit-lines)・専用のキャッシュ(lib/profit-cache.ts)を用意した。
export type ProfitLine = {
  sales_line_id: number;
  branch_code: string | null;
  rep_code: string | null;
  customer_code: string | null;
  customer_name: string | null;
  delivery_date: string | null;
  revenue: number;
  cost: number;
};

// public.v_profit_by_order ビューの1行の型(利益ダッシュボード・受注番号単位)
export type ProfitOrder = {
  order_no: string;
  customer_code: string | null;
  customer_name: string | null;
  project_name: string | null;
  rep_code: string | null;
  branch_code: string | null;
  order_date: string | null;
  delivery_date: string | null;
  line_count: number;
  revenue: number;
  cost: number;
  profit: number;
  // 2026-08-04追記: メーカー直送・手配で仕入未登録、かつ売上データ側の原価(assumed_cost)も
  // ダミー値(0円/1円など)で信頼できない行の件数・売上額。このような行は原価不明のため、
  // 利益を過大計上しないよう暫定的に「原価=売上(利益0円)」として計算している。
  // 0件より大きい場合、その受注の利益は「原価未確定の売上ぶんは利益0円と仮定した数字」であり、
  // 実際の仕入が判明すればこの受注の利益・利益率は変わる可能性がある。
  unconfirmed_cost_line_count: number;
  unconfirmed_cost_revenue: number;
};

// public.stock_transfer_pending テーブルの1行の型(社内間金額・未納品スナップショット)
export type TransferPendingLine = {
  id: number;
  order_no: string | null;
  order_line: string | null;
  order_date: string | null;
  branch_code: string | null;
  shipping_code: string | null;
  shipping_name: string | null;
  delivery_dest_name: string | null;
  customer_name: string | null;
  item_code: string | null;
  item_name: string | null;
  order_qty: number | null;
  delivery_qty: number | null;
  assumed_cost: number | null;
  created_at: string;
};

// public.shipping_note_mapping テーブルの1行の型(運賃照合・送り状番号↔受注番号の対応表)
export type ShippingNoteMappingRow = {
  id: number;
  waybill_no: string;
  order_no: string | null;
  package_count: number | null;
  carrier_code: string | null;
  carrier_name: string | null;
  customer_code: string | null;
  customer_name: string | null;
  issue_date: string | null;
  created_at: string;
};

// sales_lines のうち直近数か月分の行(運賃照合機能で使う)。
// 2026-08-06追記: 当初はitem_code='99'(運賃)行だけを取得していたが、
// 「99運賃行が無い=まだ受注に運賃行を追加していないだけで、売上自体は
// 存在する(＝本来請求すべき運賃を取りこぼしている)」ケースと、「そもそも
// その受注番号の売上データが無い(＝まだ未売上)」ケースを区別したいという
// 要望を受け、item_codeを問わず直近分を全件取得する形に変更。
// item_code='99'の行からは得意先に実際に請求した運賃(sell_price)・
// 社内の見込み原価(assumed_cost)を、それ以外も含めた全行からは
// 拠点番号・営業担当・売上番号(納品書番号)など「その受注番号の売上データが
// 存在するかどうか」を判定する。
export type FreightSalesLine = {
  order_no: string | null;
  order_line: string | null;
  branch_code: string | null;
  rep_code: string | null;
  delivery_note_no: string | null;
  customer_code: string | null;
  customer_name: string | null;
  item_code: string | null;
  sell_price: number | null;
  assumed_cost: number | null;
  delivery_date: string | null;
};
