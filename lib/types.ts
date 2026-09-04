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
  // 2026-09-03追加: 営業担当者コード。運賃照合(FreightCheck)の拠点・得意先・担当の
  // 特定を、売上データとの照合に頼らず問合せCSV側だけで完結させるために追加。
  rep_code: string | null;
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

// public.freight_actual_summary テーブルの1行の型(運賃実績集計・2026-09-02追加)
//
// 背景: 運賃照合(FreightCheck)は個々の送り状単位の突き合わせをその場で行うだけで
// Supabaseには何も保存しない。拠点/営業担当/得意先別の利益計算に運賃の実費を
// 反映させたいという要望を受け、運賃照合の結果を「20日締め期間×拠点/営業担当/
// 得意先」単位に集計してこのテーブルへ保存できるようにした(保存は運賃照合画面
// から手動で行う。自動集計・自動保存はしない)。
//
// branch_code・rep_code・customer_code・customer_name は、受注番号が判明しなかった
// 行(no_mapping)や売上データ自体が無かった行(no_sales_data)では特定できないため、
// その場合は空文字列(""、NULLではない。UNIQUE制約でNULL同士が別行扱いになる問題を
// 避けるため空文字列に統一している)で「不明」グループとして集計される。
//
// 2026-09-02追記(source_label): 西濃運輸(兵庫)・西濃運輸(土浦)のように、同じCSV列
// 構成(＝同じcarrier値)でも実際には別々の契約・請求書として、別々のタイミングで
// アップロードされることがある。carrierだけを洗い替え(削除→再挿入)の単位にすると、
// 後から保存した方が先に保存した別拠点分のデータを消してしまう不具合があったため、
// 「どの請求元(拠点・契約)のデータか」を表すsource_labelを追加し、洗い替え・
// UNIQUE制約のキーに含めた(period_end, carrier, source_label, branch_code, rep_code,
// customer_code, customer_nameの組み合わせで一意)。運賃照合画面のアップロード時に
// ファイルごとに入力する。
export type FreightActualSummaryRow = {
  id: number;
  period_end: string; // 20日締め期間の末日(例: "2025-12-20")
  carrier: string;
  source_label: string; // 請求元(拠点・契約)ラベル。例: "西濃(兵庫)"、"西濃(土浦)"、"福通(土浦)"
  branch_code: string; // 不明の場合は ""
  rep_code: string; // 不明の場合は ""
  customer_code: string; // 不明の場合は ""
  customer_name: string; // 不明の場合は ""
  shipment_count: number;
  matched_count: number;
  no_freight_charge_count: number;
  no_sales_data_count: number;
  no_mapping_count: number;
  actual_freight: number; // 実費運賃合計(全件)
  charged_freight: number; // 得意先への請求運賃合計(matched・no_freight_chargeのみ)
  margin: number; // charged_freight - (matched・no_freight_chargeぶんのactual_freight)
  source_files: string | null;
  created_at: string;
  updated_at: string;
};

// public.profit_summary テーブルの1行の型(拠点・営業担当・得意先別 利益集計・2026-09-03追加)
//
// 背景: 従来の売上利益ダッシュボード(/profit、v_profit_by_order)の「利益」は
// 売上総利益(revenue - cost、いわゆる粗利)止まりで、運賃の実費(freight_actual_summary、
// Seino請求データを取り込んで判明するようになった実費)が反映されていなかった。
// ユーザーの要望は「運賃の利益(運賃の請求額と実費の差)を見たいのではなく、
// 運賃の実費も引いた後の本当の利益・粗利率が見たい」というもの。
// そのため、v_profit_lines(売上行単位、原価ロジックは在庫/メーカー直送/運賃行の
// 出所を区別した既存の正しいものを踏襲)を「20日締め期間×拠点×営業担当×得意先」に
// 集計したうえで、同じ期間・拠点・営業担当・得意先のfreight_actual_summaryの
// 実費運賃(actual_freight)を差し引いた最終利益(final_profit)まで持たせた
// 事前集計テーブル。
//
// gross_profit = revenue - cost (従来の「売上利益」概念、変更なし)
// final_profit = gross_profit - freight_actual (ユーザーが本当に見たい「利益」)
// gross_margin_pct / final_margin_pct は revenue=0 のときは null (0除算を避けるため、
// DB側で計算済み。フロント側で複数行を合算するときも、%だけを平均するのではなく
// 必ず合計後の実額から再計算すること)。
//
// branch_code は、送り状↔受注番号のマッピングが取れず売上側の拠点/営業担当/得意先が
// 特定できなかった「運賃だけの孤立行」(freight-only orphan row。2026-09時点で全21,399行中
// 3,303行)では ""(不明。NULLではない。freight_actual_summaryと同じ理由でUNIQUE制約上
// NULL同士を区別するため)になる。この場合 revenue/cost/gross_profit は0で、
// final_profitは freight_actual をそのまま差し引いたマイナス値になる
// (=請求先が特定できない運賃コストがある、という意味)。
// rep_code・customer_code・customer_nameは現時点でNOT NULL制約が無いためNULLもあり得る
// (branch_codeほど厳密に""に統一されている保証がない)。画面側ではNULLと""の両方を
// 「不明」として同じに扱うこと(FreightActualSummary.tsxのcustomerLabel()と同じ考え方)。
export type ProfitSummaryRow = {
  id: number;
  period_end: string; // 20日締め期間の末日(例: "2026-06-20")
  branch_code: string; // 不明(運賃だけの孤立行)の場合は ""。それ以外は必ず実コード
  rep_code: string | null;
  customer_code: string | null;
  customer_name: string | null;
  revenue: number;
  cost: number;
  gross_profit: number; // revenue - cost (従来の「売上利益」)
  gross_margin_pct: number | null; // gross_profit/revenue*100、小数2桁。revenue=0ならnull
  freight_actual: number; // 実費運賃合計(freight_actual_summary.actual_freightの合算)
  final_profit: number; // gross_profit - freight_actual (ユーザーが見たい「利益」)
  final_margin_pct: number | null; // final_profit/revenue*100、小数2桁。revenue=0ならnull
  line_count: number; // この行に集計されたv_profit_lines側の明細行数
  created_at: string;
  updated_at: string;
};
