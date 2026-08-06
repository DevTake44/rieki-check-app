// 売上(uriage.csv)・仕入(2025仕入.xlsxと同じ列構成のCSV)の生データ行(文字列配列)を、
// Supabaseのテーブル(sales_lines / purchase_lines)にそのまま insert/upsert できる形へ変換する。
//
// 列番号(0始まり)は、過去にPythonで解析した際に確定させたものと同じ。
// 売上側: 0=得意先コード, 2=得意先名1, 11=受注番号, 12=受注行番号, 15=納品書番号,
//         16=納品書行数, 21=受注年月日, 22=納品年月日, 23=営業所コード, 24=営業担当,
//         27=品番, 29=品名, 34=受注総数量, 37=納品総数量, 39=販売単価, 40=金額,
//         42=出荷場所コード(AQ列), 43=出荷場所名(AR列), 46=件名(物件名), 49=手配区分,
//         50=仕入先コード(AY列), 51=仕入先名1, 53=原価(BB列)
// 仕入側: 2=仕入先名1, 15=仕入番号, 16=仕入行番号, 17=受注番号, 18=受注行番号,
//         22=仕入年月日, 27=品番, 29=品名, 36=仕入バラ数, 39=単価, 52=得意先名1(納品先名)
//
// 注意(2026-07-30に判明): 売上側のqtyは「受注総数量(34列目)」ではなく
// 「納品総数量(37列目)」を使う。1つの受注が複数回・複数月に分けて納品される場合や、
// 返品→再売上の訂正が入る場合、行ごとの「受注総数量」は0や実態と異なる値になり得るが、
// 「納品総数量」はその行(その納品書番号)で実際に動いた数量を正しく表す。
// 実データで sum(納品総数量 × 販売単価) が「金額」列(40列目)と完全一致することを確認済み。
//
// 追加(2026-07-31、社内間金額機能のため): 出荷場所コード・出荷場所名(AQ・AR列)、
// 仕入先コード(AY列)、納品年月日(22列目、delivery_date)を新たに取り込む。
// 集計ルール(2026-07-31にユーザーと確認済み):
//   ・在庫区分・手配区分: 出荷場所コードが1〜199(倉庫・拠点)の行を対象に、
//     原価(BB列, 既存のassumed_cost) × 売上数量 を出荷場所別に集計。
//     出荷場所コード200(直送)・201(入荷先変更)は対象外。
//   ・メーカー直送区分: 仕入先コードが1〜199(＝実在の外部業者ではなく社内の
//     拠点・倉庫)の行だけを対象に、同様に原価×売上数量を仕入先別に集計。
//   ・期間は「受注年月日」ではなく「納品年月日」の20日締め(例: 202606 = 5/21〜6/20)。
// 仕入CSVは使わない。
//
// 追加(2026-07-31、拠点間の純粋な在庫移動を拾うため): 納入先名1(7列目、
// delivery_dest_name)・受注総数量(34列目、order_qty)を新たに取り込む。
// 拠点間の在庫移動(倉庫→拠点への振替)は売上を伴わないため金額(40列目)が常に0で、
// 納品総数量(37列目、既存のqty)も0のままのことが多い。この場合は「受注総数量×原価」
// で評価する。判定は「手配区分=在庫」かつ「納入先名1が実在の得意先ではなく自社拠点/
// 倉庫(『太幸○○』のような名前)」の行。得意先コードの頭2桁が拠点コードという規則も
// あるが、拠点9(長野)が「09」始まりになるなど桁合わせで拠点91と紛らわしいため、
// 判定には使わない。
//
// 追加(2026-08-03、利益ダッシュボード機能のため): 得意先コード(0列目、customer_code)・
// 件名(46列目、project_name)を新たに取り込む。得意先コードは得意先名だけでは表記ゆれで
// 集計がずれる可能性があるため、得意先単位の集計キーとして使う。件名は「物件」(工事物件
// 向けなどのまとめ売上)の識別に使う値で、通常の店舗向け売上では空欄のことが多い。
// 「{件名}一式」行(受注番号=0・受注行番号=0、上で除外済み)は、この件名を使って複数の
// 明細行をまとめた概算行だった。

export type SalesRowInsert = {
  order_no: string | null;
  order_line: string | null;
  order_date: string | null;
  delivery_date: string | null;
  customer_code: string | null;
  customer_name: string | null;
  supplier_name: string | null;
  supplier_code: string | null;
  branch_code: string | null;
  rep_code: string | null;
  arrange_type: string | null;
  item_code: string | null;
  item_name: string | null;
  project_name: string | null;
  qty: number | null;
  sell_price: number | null;
  assumed_cost: number | null;
  delivery_note_no: string | null;
  delivery_note_line: string | null;
  shipping_code: string | null;
  shipping_name: string | null;
  delivery_dest_name: string | null;
  order_qty: number | null;
};

// 受注出力CSV(社内間・未納品の拠点間移動を拾うためのもの)から
// stock_transfer_pending テーブルへ変換する型。列構成はsales_lines用と同じ
// (0始まり、7=納入先名1, 21=受注年月日, 23=営業所コード, 27=品番, 29=品名,
//  34=受注総数量, 37=納品総数量, 49=手配区分, 53=原価)。
export type TransferRowInsert = {
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
};

export type PurchaseRowInsert = {
  order_no: string | null;
  order_line: string | null;
  purchase_no: string | null;
  purchase_line: string | null;
  purchase_date: string | null;
  supplier_name: string | null;
  customer_name: string | null;
  item_code: string | null;
  item_name: string | null;
  qty: number | null;
  unit_price: number | null;
};

const MIN_SALES_COLS = 54;
const MIN_PURCHASE_COLS = 55;

// 保持対象の会計期間(会社の期は9/20区切り、2期分): 2024/9/21〜2026/9/20。
// Supabase無料枠(500MB)の容量を、気づかないうちに超えてしまうことがないよう、
// この期間より前・後の受注日/仕入日を持つ行は取り込まない(2026-07-30時点で導入)。
// 対象期間を変更する場合は、この2つの定数を変更する。
const RETENTION_FROM = "2024-09-21";
const RETENTION_TO = "2026-09-20";

// 日付が期間外(かつ日付が取得できている場合)なら true。
// 日付が取れない行(dateOrNullがnullを返す行)は、この判定では従来通り除外しない。
function isOutsideRetentionWindow(dateStr: string | null): boolean {
  if (dateStr === null) return false;
  return dateStr < RETENTION_FROM || dateStr > RETENTION_TO;
}

function cell(cols: string[], i: number): string {
  const v = cols[i];
  return v === undefined || v === null ? "" : v.trim();
}

function textOrNull(cols: string[], i: number): string | null {
  const v = cell(cols, i);
  return v === "" ? null : v;
}

function numOrNull(cols: string[], i: number): number | null {
  const v = cell(cols, i);
  if (v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// "20260423" -> "2026-04-23" / 空欄・"0" -> null
function dateOrNull(cols: string[], i: number): string | null {
  const v = cell(cols, i);
  if (v === "" || v === "0") return null;
  if (/^\d{8}$/.test(v)) {
    return `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`;
  }
  // 既に "2026-04-23" のような形式で入っている場合はそのまま
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  return null;
}

/**
 * 1行が完全に空行(全列が空文字)かどうかを判定する。
 * CSVの末尾に混ざる空行を除外するために使う。
 */
export function isBlankRow(cols: string[]): boolean {
  return cols.every((c) => (c ?? "").trim() === "");
}

export function mapSalesRow(cols: string[]): SalesRowInsert | null {
  if (isBlankRow(cols)) return null;
  if (cols.length < MIN_SALES_COLS) return null;

  const order_no = textOrNull(cols, 11);
  const order_line = textOrNull(cols, 12);
  const item_name = textOrNull(cols, 29);

  // 「{件名}一式」行(受注番号=0, 受注行番号=0)は、複数の受注番号をまとめたプロジェクトの
  // 概算(まとめ)行。受注総数量は0だが、販売単価・金額には実額が入っている
  // (2026-07-30時点、訂正: 以前「常に0円」としたのは誤りで、実際は実額あり)。
  // 品目別の原価明細は別ファイル「物件」側に入っており、値上げ検知(原価比較)には
  // この一式行自体は使えない(原価が無い)ため取り込まない。ただし、この一式行の金額と
  // 「物件」ファイルの明細金額はほぼ同じプロジェクトの概算/内訳の関係にあるため、両方を
  // そのまま合計すると二重計上になる。合計金額(sales_lines全体)は公式の売上管理表とは
  // 完全には一致しない設計であることを踏まえておくこと(小さな差は許容する前提)。
  if (order_no === "0" && order_line === "0") return null;

  // 「伝票消費税」行(受注番号ごとに1行存在する消費税の内訳行)は、品名以外の列が
  // 全てNULL(受注番号もNULL)で、値上げ検知には使えないデータ。しかも受注番号がNULLの
  // ため一意制約で重複判定できず、同じファイルを再アップロードするたびに増殖してしまう
  // (2026-07-30時点、実データで10,505件・全件の41%を確認)。取り込まない。
  if (item_name === "伝票消費税") return null;

  const order_date = dateOrNull(cols, 21);

  // 対象2期間(2024/9/21〜2026/9/20)より前・後の受注日は取り込まない。
  if (isOutsideRetentionWindow(order_date)) return null;

  return {
    order_no,
    order_line,
    order_date,
    delivery_date: dateOrNull(cols, 22),
    customer_code: textOrNull(cols, 0),
    customer_name: textOrNull(cols, 2),
    supplier_name: textOrNull(cols, 51),
    supplier_code: textOrNull(cols, 50),
    branch_code: textOrNull(cols, 23),
    rep_code: textOrNull(cols, 24),
    arrange_type: textOrNull(cols, 49),
    item_code: textOrNull(cols, 27),
    item_name: textOrNull(cols, 29),
    project_name: textOrNull(cols, 46),
    qty: numOrNull(cols, 37),
    sell_price: numOrNull(cols, 39),
    assumed_cost: numOrNull(cols, 53),
    delivery_note_no: textOrNull(cols, 15),
    delivery_note_line: textOrNull(cols, 16),
    shipping_code: textOrNull(cols, 42),
    shipping_name: textOrNull(cols, 43),
    delivery_dest_name: textOrNull(cols, 7),
    order_qty: numOrNull(cols, 34),
  };
}

// 受注出力CSVの行を、社内間(未納品の拠点間移動)候補としてフィルタする。
// 条件(2026-07-31にユーザーと確認済み、2026-08-05に拠点90/91向けの条件を追加):
// 手配区分=在庫の行のうち、
//   ・営業所コード(拠点)が90(鳴尾在庫)または91(土浦物流)の場合は、納入先名1の
//     文字列に関わらず全件を対象とする。手配区分=在庫の時点で出荷元は社内(自社倉庫)
//     であることが保証されており、メーカー直送・手配(＝仕入先からの直送)は
//     このarrange_typeチェックで既に除外されているため、90/91向けは無条件で拾ってよい。
//     (2026-08-05判明: 拠点91宛の行は納入先名1が「土浦物流センター　在庫」のように
//     「太幸」を含まない表記になっており、以前の条件では漏れていた。実データで
//     12行・2,032,150円が未取り込みだったことを確認して修正。)
//   ・それ以外の拠点の場合は、従来通り納入先名1に「太幸」を含む(＝納入先が実在の
//     外部得意先ではなく自社拠点/倉庫)行だけを対象とする。
//
// 2026-08-05に「納品総数量0(未売上)なら宛先を問わず全件拾う」方式も試したが、
// 実在する得意先向けの未納品注文まで大量に混ざる(実データで約7割相当)ことが
// 確認されたため、ユーザーの判断でこの拠点90/91＋太幸表記による絞り込み方式に
// 戻した。あえて広げない。
// この関数を通過する行は少数(実データで1777行中60〜70件程度)になる想定で、
// stock_transfer_pending テーブルはアップロードのたびに全件洗い替えする。
const INTERNAL_WAREHOUSE_BRANCH_CODES = new Set(["90", "91"]);

export function mapTransferRow(cols: string[]): TransferRowInsert | null {
  if (isBlankRow(cols)) return null;
  if (cols.length < MIN_SALES_COLS) return null;

  const arrange_type = textOrNull(cols, 49);
  if (arrange_type !== "在庫") return null;

  const branch_code = textOrNull(cols, 23);
  const delivery_dest_name = textOrNull(cols, 7);

  const isInternalWarehouseBranch = branch_code !== null && INTERNAL_WAREHOUSE_BRANCH_CODES.has(branch_code);
  if (!isInternalWarehouseBranch) {
    if (!delivery_dest_name || !delivery_dest_name.includes("太幸")) return null;
  }

  return {
    order_no: textOrNull(cols, 11),
    order_line: textOrNull(cols, 12),
    order_date: dateOrNull(cols, 21),
    branch_code,
    shipping_code: textOrNull(cols, 42),
    shipping_name: textOrNull(cols, 43),
    delivery_dest_name,
    customer_name: textOrNull(cols, 2),
    item_code: textOrNull(cols, 27),
    item_name: textOrNull(cols, 29),
    order_qty: numOrNull(cols, 34),
    delivery_qty: numOrNull(cols, 37),
    assumed_cost: numOrNull(cols, 53),
  };
}

// 「送り状問合せ」CSVの行を、shipping_note_mapping テーブル用に変換する。
// 運賃照合機能(2026-08-06追加)で使う、送り状番号(＝運送会社の請求データ側の
// 「原票No.」と同じ体系) ↔ 自社の受注番号 の対応表。
// 列構成(0始まり、実データで確認): 0=得意先コード, 1=得意先名, 2=状態, 3=受注番号,
// 4=個口, 5=営業担当者コード, 6=営業担当者名, 7=運送会社コード, 8=運送会社名,
// 9=荷受人, 10=発行日, 11=時刻, 12〜14=記事1〜3, 15=送り状番号,
// 16=入力担当者コード, 17=入力担当者名, 18=荷造担当者コード, 19=荷造り担当者名。
export type ShippingNoteRowInsert = {
  waybill_no: string;
  order_no: string | null;
  package_count: number | null;
  carrier_code: string | null;
  carrier_name: string | null;
  customer_code: string | null;
  customer_name: string | null;
  issue_date: string | null;
};

const MIN_SHIPPING_NOTE_COLS = 16;

export function mapShippingNoteRow(cols: string[]): ShippingNoteRowInsert | null {
  if (isBlankRow(cols)) return null;
  if (cols.length < MIN_SHIPPING_NOTE_COLS) return null;

  const waybill_no = textOrNull(cols, 15);
  // 送り状番号が無い行は突き合わせのキーが無いので取り込まない。
  if (!waybill_no) return null;

  return {
    waybill_no,
    order_no: textOrNull(cols, 3),
    package_count: numOrNull(cols, 4),
    carrier_code: textOrNull(cols, 7),
    carrier_name: textOrNull(cols, 8),
    customer_code: textOrNull(cols, 0),
    customer_name: textOrNull(cols, 1),
    issue_date: dateOrNull(cols, 10),
  };
}

export function mapPurchaseRow(cols: string[]): PurchaseRowInsert | null {
  if (isBlankRow(cols)) return null;
  if (cols.length < MIN_PURCHASE_COLS) return null;

  const item_name = textOrNull(cols, 29);

  // 「伝票消費税」行は仕入側にも存在する(2026-07-30時点、実データで33,715件・
  // purchase_lines全体の約8%を確認)。仕入番号(purchase_no)もNULLのため、一意制約で
  // 重複判定できず、同じファイルを再アップロードするたびに増殖してしまう。
  // 値上げ検知にも使えないデータのため取り込まない(売上側のmapSalesRowと同じ理由)。
  if (item_name === "伝票消費税") return null;

  const purchase_date = dateOrNull(cols, 22);

  // 対象2期間(2024/9/21〜2026/9/20)より前・後の仕入日は取り込まない。
  if (isOutsideRetentionWindow(purchase_date)) return null;

  return {
    order_no: textOrNull(cols, 17),
    order_line: textOrNull(cols, 18),
    purchase_no: textOrNull(cols, 15),
    purchase_line: textOrNull(cols, 16),
    purchase_date,
    supplier_name: textOrNull(cols, 2),
    customer_name: textOrNull(cols, 52),
    item_code: textOrNull(cols, 27),
    item_name: textOrNull(cols, 29),
    qty: numOrNull(cols, 36),
    unit_price: numOrNull(cols, 39),
  };
}
