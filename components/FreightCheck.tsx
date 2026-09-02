"use client";

import { useMemo, useState } from "react";
import Papa from "papaparse";
import type { ShippingNoteMappingRow, FreightSalesLine } from "@/lib/types";
import Link from "next/link";

/**
 * 運賃照合ダッシュボード
 *
 * 目的: 西濃運輸・福山通運から実際に請求された運賃(実費)を、自社が得意先に請求した
 * 運賃(sales_lines の 商品コード="99"・品名"運賃"行、sell_price)と突き合わせ、
 * 運賃で利益が取れているか(請求額 > 実費)を一覧化する。
 *
 * ■ 突き合わせの流れ
 * 1. 運送会社の請求データ(このページでドラッグ&ドロップ、都度その場で読み込むだけで
 *    Supabaseには保存しない)から、送り状番号(＝原票No./原票番号)と実費運賃を取り出す。
 * 2. 送り状番号を、事前にSupabaseへ取り込んである shipping_note_mapping
 *    (「送り状問合せ」CSVから作った、送り状番号↔自社の受注番号の対応表。3か月分プール)
 *    で受注番号に変換する。
 * 3. その受注番号で sales_lines の運賃行(商品コード="99")を探し、得意先への請求額
 *    (sell_price)を取得、実費と比較する。
 *
 * ■ 2026-08-06追記: 4パターンの状態を区別する
 * 受注番号が判明した後、sales_lines側の状況によって次の4通りに分ける
 * (ユーザーとの確認: 「99運賃行が無い」＝運賃の請求漏れ、「売上データ自体が無い」＝
 * まだ未売上、はまったく意味が違うので混同しないこと):
 *   ・matched: 受注番号があり、かつその受注に商品コード="99"(運賃)行がある
 *     → 実際の請求額(sell_price)と実費を比較。
 *   ・no_freight_charge: 受注番号があり、その受注の売上データ(item_code問わず)は
 *     存在するが、運賃(コード99)行だけが無い → 売上はあるのに運賃を請求し忘れている
 *     状態。拠点番号・営業担当・売上番号(納品書番号)はその受注の売上行から取得して
 *     表示し、請求運賃=0円とみなして利益(0−実費)を計算する(=実費全額が持ち出しの
 *     赤字として可視化される)。
 *   ・no_sales_data: 受注番号はあるが、その受注の売上データ自体がsales_linesに
 *     一件も無い(＝まだ未売上、これから売上が立つ予定など) → 判断材料が無いので
 *     拠点番号・営業担当・売上番号・請求運賃・利益は空欄のままにする(無理に0円と
 *     みなさない)。
 *   ・no_mapping: 送り状番号が対応表(shipping_note_mapping)に無く、受注番号自体が
 *     わからない → 従来通り空欄。
 *
 * ■ 2社のファイル形式の違い
 * 西濃運輸: 月,日,原票No.,元着,区分,着地名/発地名,数量,重量,合計(運賃),
 *   内燃料サーチャージ,備考1,備考2,お客さま番号。年が無いため日付は月/日のみの表示。
 *   「原票No.」が"999"始まりの行は、特定の送り状に紐づかない燃料サーチャージの
 *   アカウント単位集計行(着地名が空)で、送り状番号としてはヒットしない
 *   (=自動的に「対応する受注が見つからない」扱いになる。これは仕様として正しい)。
 *   配達場所(県・市)は「着地名/発地名」列。得意先名の対応表(shipping_note_mapping)に
 *   無い場合のフォールバック表示には「備考1」列(得意先名が入っていることが多い)を使う。
 * 福山通運: 得意先コード,部課所コード,締め日,請求書番号,発送年月日,原票番号,特殊コード,
 *   元着区分,個数,才数,重量,運賃,中継料,保険料,諸料金,諸料金区分,住所漢字区分,荷受人住所,
 *   名称漢字区分,荷受人名称,荷受人コード,お客様出荷番号,ＪＩＳコード,輸送距離,備考,
 *   サーチャージ料。実費は「運賃+中継料+保険料+諸料金+サーチャージ料」の合計とする
 *   (運賃だけでなく実際に支払う金額全体で比較するため)。発送年月日はYYMMDD(西暦下2桁)。
 *   配達場所(県・市)は「荷受人住所」列。「荷受人名称」は福通側の営業所名等になっている
 *   ことが多く得意先名としては使えないため、得意先不明時のフォールバック表示は無し。
 * 西濃運輸(東京本社): 回収店コード,回収店名称,請求荷主コード,荷送人コード,荷送人名称,…,
 *   受付年月日,元着選択,元着選択名称,お問合せ番号,お届け先名称１,…,直通運賃,諸料金,減額,
 *   実費,運賃合計,備考,…,管理番号,… という形式。他の2社と違い、送り状番号↔受注番号の
 *   対応表(shipping_note_mapping)を経由せず、「管理番号」列がそのまま自社の受注番号
 *   そのものになっている(2026-08-26判明: 太幸側でAR/売上計上に使う受注番号を、西濃側が
 *   請求データにそのまま印字して返してくれる形式のため)。そのため管理番号を直接
 *   orderNoとして使い、実費は「運賃合計」列を使う。お問合せ番号が空欄の行(特定の送り状に
 *   紐づかない燃料サーチャージ等の集計行)だけを対象外とし、管理番号が空欄でもお問合せ番号
 *   がある行は結果に含める(受注番号不明として扱う)。配達場所(県・市)は「着地名称」列。
 *   得意先不明時のフォールバック表示には「お届け先名称１」列を使う。
 *
 * ファイル形式は、ヘッダー行に「管理番号」を含むか「原票No」を含むか「原票番号」を
 * 含むかで自動判別する。
 *
 * ■ 2026-08-27追加: 西濃運輸(東京本社)の「受注番号不明分」FAX依頼シート
 * 西濃運輸(東京本社)は、請求データの「管理番号」列がそのまま自社の受注番号になる
 * 形式だが、西濃側で管理番号の記入が漏れている行(＝status="no_mapping")は、
 * こちらの売上データから当てようがない(お問合せ番号だけでは受注が特定できない)。
 * このような行は、西濃運輸に直接FAXで送り状の控えを取り寄せて内容を確認するのが
 * 従来からの運用(ユーザー提供の実際のFAX依頼用紙を参考に再現)。そのため、
 * status="no_mapping"かつcarrier="西濃運輸(東京本社)"の行だけを別枠の一覧に出し、
 * チェックした行を、その依頼用紙と同じ体裁(西濃運輸㈱御中/返信先FAX/日付・お問合せ
 * 番号の表/太幸側の署名)のCSVとしてダウンロードできるようにしている。この一覧・
 * ダウンロードは西濃運輸(東京本社)専用(他の2社の「対応する受注が見つからない」行は
 * 対象外、従来通り明細一覧・全体CSVの方で確認する)。
 *
 * ■ 2026-08-27追記(1): Excelで開いた時の見た目崩れ対策(CSV版、後に(2)で置き換え)
 * 上記CSVをExcelで開くと、「日付」列(2026/07/14のような文字列)が日付として、
 * 「お問合せ番号」列(1797806829のような数字の並び)が数値として自動認識されてしまい、
 * 列幅が足りないと「#######」やE+09のような指数表記で表示され、そのままではFAXに
 * 使えない不具合があった(実際の報告あり)。最初は新しい依存関係を増やさずに、各セルの
 * 先頭に半角シングルクォート(')を付けてExcelに文字列として認識させるCSVの改良で
 * 対応した。
 *
 * ■ 2026-08-27追記(2): 本物のxlsxファイルを生成する方式に変更
 * (1)の対策後も、「列幅が安定しない(Excel側の自動調整に左右される)」「文字サイズを
 * 指定したい」という要望があった。CSVはファイル形式そのものに列幅・フォントサイズ・
 * 罫線などの情報を持てない(Excelが開くたびに独自に解釈するしかない)ため、CSVの
 * 改良では原理的に解決できない。そのため、ユーザーが実際に手動で列幅・フォント
 * サイズ・罫線を整えて送ってくれたサンプル(西濃東京_送り状控えFAX依頼_20260827.xlsx)
 * と全く同じレイアウトになるよう、ブラウザ上で本物のxlsxファイルを組み立てて
 * ダウンロードする方式(exceljsライブラリ使用)に切り替えた。列幅(A:14.125/
 * B:16.25/C:15.0/D:24.25)・フォント(游ゴシック、タイトルのみ16pt、他11pt)・
 * 罫線(表部分のみ格子状の細線)は、そのサンプルの値をそのまま踏襲している。
 * exceljsは今回新しく追加した依存パッケージ(package.json参照)で、この開発環境では
 * npm installができないためローカルでのビルド検証ができていない。Vercel側のビルド
 * ログでエラーが出た場合はスクリーンショットを共有してもらえれば対応する。
 */

type Carrier = "西濃運輸" | "福山通運" | "西濃運輸(東京本社)";

// 西濃運輸(東京本社)への「送り状の控えFAX依頼」用紙の固定項目(2026-08-27追加、
// ユーザー提供の実際の依頼用紙の記載内容そのまま)。FAX番号が変わった場合はここを直す。
// SEND_NUMBER=西濃運輸側の受信FAX番号(ここに送る)、REPLY_NUMBER=太幸側の返信先FAX番号。
const SEINO_TOKYO_FAX_SEND_NUMBER = "03-3522-6767";
const SEINO_TOKYO_FAX_REPLY_NUMBER = "03-5444-2117";
const SEINO_TOKYO_FAX_SENDER_LABEL = "㈱太幸　経理";
const SEINO_TOKYO_FAX_SENDER_TEL = "03-6435-4440";

type InvoiceLine = {
  carrier: Carrier;
  waybillNo: string;
  dateLabel: string;
  amount: number;
  // 得意先が特定できない時のフォールバック表示用(2026-08-26追加)。会社ごとに
  // 一番それらしい名称項目(西濃=備考1、西濃(東京本社)=お届け先名称、福通=無し)を入れる。
  destinationName: string;
  // 配達場所(県・市)。会社ごとの住所/着地名項目からそのまま取る(2026-08-26追加)。
  deliveryLocation: string;
  note: string;
  sourceFile: string;
  // 西濃運輸(東京本社)のみ設定される。設定されている場合、送り状番号↔受注番号の
  // 対応表(shipping_note_mapping)を経由せず、この値をそのまま受注番号として使う。
  directOrderNo?: string;
  // 2026-09-02追加(運賃実績集計): この行が属する20日締め期間の末日(YYYY-MM-DD)。
  // 福山通運・西濃運輸(東京本社)は行ごとに実際の年月日が分かるので自動計算できるが、
  // 西濃運輸(標準)は年が印字されないため自動計算できず、undefinedのままにする
  // (アップロード後、ファイル単位でユーザーに締め日を手入力してもらう)。
  periodEnd?: string;
};

// 20日締め期間の末日を計算する(21日以降は翌月20日、1〜20日はその月の20日)。
// 例: 2025-11-21〜2025-12-20分は "2025-12-20"、2025-12-21〜2026-01-20分は "2026-01-20"。
function computePeriodEnd(year: number, month: number, day: number): string {
  let y = year;
  let m = month;
  if (day > 20) {
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return `${y}-${String(m).padStart(2, "0")}-20`;
}

// "YYYY/MM/DD" 形式の dateLabel(福山通運・西濃運輸(東京本社)が使う)から期間末日を計算する。
function periodEndFromYmdLabel(dateLabel: string): string | undefined {
  const m = /^(\d{4})\/(\d{2})\/(\d{2})$/.exec(dateLabel);
  if (!m) return undefined;
  return computePeriodEnd(Number(m[1]), Number(m[2]), Number(m[3]));
}

type MatchStatus = "matched" | "no_mapping" | "no_freight_charge" | "no_sales_data";

type ResultRow = {
  key: string;
  carrier: Carrier;
  waybillNo: string;
  dateLabel: string;
  deliveryLocation: string;
  orderNo: string | null;
  customerCode: string | null;
  customerName: string | null;
  branchCode: string | null;
  repCode: string | null;
  deliveryNoteNo: string | null;
  actualFreight: number;
  chargedFreight: number | null;
  margin: number | null;
  status: MatchStatus;
  // 2026-09-02追加(運賃実績集計): この行が属する20日締め期間の末日。
  // 西濃運輸(標準)はファイル単位でユーザーが手入力するまでnull。
  periodEnd: string | null;
  sourceFile: string;
};

type FileState = {
  fileNames: string[];
  loading: boolean;
  errors: string[];
};

function initialFileState(): FileState {
  return { fileNames: [], loading: false, errors: [] };
}

async function readFileSmart(file: File): Promise<{ text: string; encoding: string }> {
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { text: new TextDecoder("utf-8").decode(buf), encoding: "UTF-8 (BOM付き)" };
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(buf);
    return { text, encoding: "UTF-8" };
  } catch {
    const text = new TextDecoder("shift_jis").decode(buf);
    return { text, encoding: "Shift_JIS (CP932)" };
  }
}

function fmtYen(n: number | null): string {
  if (n === null || Number.isNaN(n)) return "―";
  return `¥${Math.round(n).toLocaleString("ja-JP")}`;
}

function cell(cols: string[], i: number): string {
  const v = cols[i];
  return v === undefined || v === null ? "" : String(v).trim();
}

function detectCarrier(headerCols: string[]): Carrier | null {
  const joined = headerCols.join(",");
  if (joined.includes("管理番号") && joined.includes("運賃合計")) return "西濃運輸(東京本社)";
  if (joined.includes("原票No")) return "西濃運輸";
  if (joined.includes("原票番号")) return "福山通運";
  return null;
}

function parseSeinoRows(rows: string[][], fileName: string): InvoiceLine[] {
  const out: InvoiceLine[] = [];
  for (const cols of rows) {
    const waybillNo = cell(cols, 2);
    if (!waybillNo) continue;
    const month = cell(cols, 0);
    const day = cell(cols, 1);
    const amount = Number(cell(cols, 8).replace(/,/g, "")) || 0;
    // 配達場所(県・市)は「着地名/発地名」列(例: 高知県 高知市)。
    const deliveryLocation = cell(cols, 5);
    // 得意先名の対応表(shipping_note_mapping)が無いケースのフォールバック用に、
    // 「備考1」列(得意先名が入っていることが多い、例: イオンリテール㈱イオ)を使う。
    const destinationName = cell(cols, 10);
    const note = cell(cols, 11);
    out.push({
      carrier: "西濃運輸",
      waybillNo,
      dateLabel: month && day ? `${month}/${day}` : "",
      amount,
      destinationName,
      deliveryLocation,
      note,
      sourceFile: fileName,
    });
  }
  return out;
}

function parseFukuyamaRows(rows: string[][], fileName: string): InvoiceLine[] {
  const out: InvoiceLine[] = [];
  for (const cols of rows) {
    const waybillNo = cell(cols, 5);
    if (!waybillNo) continue;
    const shipDate = cell(cols, 4); // YYMMDD
    const dateLabel =
      /^\d{6}$/.test(shipDate) ? `20${shipDate.slice(0, 2)}/${shipDate.slice(2, 4)}/${shipDate.slice(4, 6)}` : shipDate;
    const freight = Number(cell(cols, 11).replace(/,/g, "")) || 0;
    const relay = Number(cell(cols, 12).replace(/,/g, "")) || 0;
    const insurance = Number(cell(cols, 13).replace(/,/g, "")) || 0;
    const misc = Number(cell(cols, 14).replace(/,/g, "")) || 0;
    const surcharge = Number(cell(cols, 25).replace(/,/g, "")) || 0;
    const amount = freight + relay + insurance + misc + surcharge;
    // 配達場所(県・市)は「荷受人住所」列(例: 広島県府中市)。
    const deliveryLocation = cell(cols, 17);
    // 「荷受人名称」は福通側の営業所名等になっていることが多く得意先名としては
    // 使えないため、得意先不明時のフォールバックは無し(空欄のまま)とする。
    const destinationName = "";
    const note = cell(cols, 24);
    out.push({
      carrier: "福山通運",
      waybillNo,
      dateLabel,
      amount,
      destinationName,
      deliveryLocation,
      note,
      sourceFile: fileName,
      periodEnd: periodEndFromYmdLabel(dateLabel),
    });
  }
  return out;
}

// 西濃運輸(東京本社)形式: 列番号(0始まり)は固定のヘッダー構成に基づく。
// 9=受付年月日, 12=お問合せ番号, 13=お届け先名称１, 26=運賃合計, 27=備考,
// 39=着地名称(県・市。例: 福岡県 糟屋郡 新宮町), 43=管理番号。
//
// 2026-08-26修正: 当初は「管理番号(43列目)が空欄の行は除外」としていたが、これだと
// お届け先名称や金額など実際の請求データが入っている行(＝管理番号を書き忘れている
// だけの実在の運賃)まで結果から消えてしまい、その分の実費が集計から漏れる不具合が
// あった(例: お問合せ番号2232440872、㈱三橋商事宛、450円の行が結果に出ない、として
// 報告された)。正しくは「お問合せ番号(12列目)が空欄の行」だけが、特定の送り状に紐づかない
// 燃料サーチャージ等の集計行にあたるので、そちらを除外基準にする。管理番号が空欄でも
// お問合せ番号がある行は結果に含め、受注番号は不明("対応する受注が見つからない")として
// 扱う(＝他の運送会社の「送り状番号はあるが対応表に無い」パターンと同じ)。
function parseSeinoTokyoRows(rows: string[][], fileName: string): InvoiceLine[] {
  const out: InvoiceLine[] = [];
  for (const cols of rows) {
    const inquiryNo = cell(cols, 12);
    if (!inquiryNo) continue; // お問合せ番号すら無い行(特定の送り状に紐づかない集計行)は対象外
    const orderNo = cell(cols, 43); // 管理番号。空欄のこともあり、その場合は受注番号不明として扱う
    const dateRaw = cell(cols, 9); // YYYYMMDD
    const dateLabel = /^\d{8}$/.test(dateRaw) ? `${dateRaw.slice(0, 4)}/${dateRaw.slice(4, 6)}/${dateRaw.slice(6, 8)}` : dateRaw;
    const amount = Number(cell(cols, 26).replace(/,/g, "")) || 0;
    const destinationName = cell(cols, 13);
    const deliveryLocation = cell(cols, 39);
    const note = cell(cols, 27);
    out.push({
      carrier: "西濃運輸(東京本社)",
      waybillNo: inquiryNo,
      directOrderNo: orderNo || undefined,
      dateLabel,
      amount,
      destinationName,
      deliveryLocation,
      note,
      sourceFile: fileName,
      periodEnd: periodEndFromYmdLabel(dateLabel),
    });
  }
  return out;
}

export default function FreightCheck({
  mappingRows,
  freightSalesLines,
}: {
  mappingRows: ShippingNoteMappingRow[];
  freightSalesLines: FreightSalesLine[];
}) {
  const [fileState, setFileState] = useState<FileState>(initialFileState());
  const [invoiceLines, setInvoiceLines] = useState<InvoiceLine[]>([]);
  const [statusFilter, setStatusFilter] = useState<"all" | MatchStatus>("all");
  const [dragOver, setDragOver] = useState(false);
  // 2026-08-27追加: 西濃運輸(東京本社)の「受注番号不明分」一覧で、FAX依頼シートに
  // 含めるためにチェックした行(ResultRow.key)の集合。
  const [selectedFaxKeys, setSelectedFaxKeys] = useState<Set<string>>(new Set());
  // 2026-09-02追加(運賃実績集計): 西濃運輸(標準)は行ごとに年が分からないため、
  // ファイル単位で締め日(20日締めの期間末日)をユーザーに手入力してもらう。
  // キーはファイル名。福山通運・西濃運輸(東京本社)は行ごとに自動計算されるため不要。
  const [seinoFilePeriodEnd, setSeinoFilePeriodEnd] = useState<Record<string, string>>({});
  const [freightSaveState, setFreightSaveState] = useState<{
    saving: boolean;
    saved: boolean;
    error: string | null;
    savedCount: number | null;
  }>({ saving: false, saved: false, error: null, savedCount: null });

  const mappingByWaybill = useMemo(() => {
    const m = new Map<string, ShippingNoteMappingRow>();
    for (const r of mappingRows) m.set(r.waybill_no, r);
    return m;
  }, [mappingRows]);

  // 受注番号ごとの「その受注の売上データが存在するか」＋拠点番号・営業担当・
  // 売上番号(納品書番号)・得意先名。商品コードを問わず全行から作るので、
  // 運賃(99)行が無い受注でも(他の商品行さえあれば)ここに載る。
  const orderInfoByOrder = useMemo(() => {
    const m = new Map<
      string,
      {
        branchCode: string | null;
        repCode: string | null;
        deliveryNoteNo: string | null;
        customerCode: string | null;
        customerName: string | null;
      }
    >();
    for (const l of freightSalesLines) {
      if (!l.order_no) continue;
      const prev = m.get(l.order_no);
      m.set(l.order_no, {
        branchCode: prev?.branchCode ?? l.branch_code,
        repCode: prev?.repCode ?? l.rep_code,
        deliveryNoteNo: prev?.deliveryNoteNo ?? l.delivery_note_no,
        customerCode: prev?.customerCode ?? l.customer_code,
        customerName: prev?.customerName ?? l.customer_name,
      });
    }
    return m;
  }, [freightSalesLines]);

  // 受注番号ごとの、商品コード="99"(運賃)行だけを合算した金額(得意先への請求額)。
  const freightByOrder = useMemo(() => {
    const m = new Map<string, number>();
    for (const l of freightSalesLines) {
      if (!l.order_no) continue;
      if (l.item_code !== "99") continue;
      m.set(l.order_no, (m.get(l.order_no) ?? 0) + (l.sell_price ?? 0));
    }
    return m;
  }, [freightSalesLines]);

  async function handleFiles(files: FileList) {
    setFileState({ fileNames: [], loading: true, errors: [] });
    setSeinoFilePeriodEnd({});
    setFreightSaveState({ saving: false, saved: false, error: null, savedCount: null });
    const allLines: InvoiceLine[] = [];
    const errors: string[] = [];
    const fileNames: string[] = [];

    for (const file of Array.from(files)) {
      fileNames.push(file.name);
      try {
        const { text } = await readFileSmart(file);
        const parsed = Papa.parse<string[]>(text, { skipEmptyLines: true });
        const rows = parsed.data;
        if (rows.length === 0) {
          errors.push(`${file.name}: データが読み込めませんでした。`);
          continue;
        }
        const header = rows[0];
        const carrier = detectCarrier(header);
        if (!carrier) {
          errors.push(
            `${file.name}: ファイル形式を判別できませんでした(西濃運輸・西濃運輸(東京本社)・福山通運のいずれの請求データ形式にも一致しません)。`
          );
          continue;
        }
        const dataRows = rows.slice(1);
        const lines =
          carrier === "西濃運輸"
            ? parseSeinoRows(dataRows, file.name)
            : carrier === "福山通運"
            ? parseFukuyamaRows(dataRows, file.name)
            : parseSeinoTokyoRows(dataRows, file.name);
        allLines.push(...lines);
      } catch (e) {
        errors.push(`${file.name}: 読み込みエラー: ${String(e)}`);
      }
    }

    setInvoiceLines(allLines);
    setFileState({ fileNames, loading: false, errors });
    // 新しいファイルを読み込んだら、古いチェック状態は意味が無いのでリセットする。
    setSelectedFaxKeys(new Set());
  }

  const results: ResultRow[] = useMemo(() => {
    return invoiceLines.map((line, i) => {
      // 西濃運輸(東京本社)は送り状番号↔受注番号の対応表を経由せず、管理番号を
      // そのまま受注番号として使う(directOrderNoが設定されている場合はそちら優先)。
      const mapRow = mappingByWaybill.get(line.waybillNo);
      const orderNo = line.directOrderNo ?? mapRow?.order_no ?? null;
      let status: MatchStatus;
      let chargedFreight: number | null = null;
      let customerCode: string | null = null;
      let customerName: string | null = mapRow?.customer_name ?? null;
      let branchCode: string | null = null;
      let repCode: string | null = null;
      let deliveryNoteNo: string | null = null;
      let margin: number | null = null;

      if (!orderNo) {
        status = "no_mapping";
      } else {
        const orderInfo = orderInfoByOrder.get(orderNo);
        const freight = freightByOrder.get(orderNo);

        if (orderInfo) {
          branchCode = orderInfo.branchCode;
          repCode = orderInfo.repCode;
          deliveryNoteNo = orderInfo.deliveryNoteNo;
          customerCode = orderInfo.customerCode;
          customerName = orderInfo.customerName ?? customerName;
        }

        if (freight !== undefined) {
          // 売上データがあり、かつ運賃(商品コード99)行もある → 通常の照合。
          status = "matched";
          chargedFreight = freight;
          margin = chargedFreight - line.amount;
        } else if (orderInfo) {
          // 売上データはあるが運賃(99)行が無い → 請求漏れ。0円請求とみなして
          // 実費全額をマイナスとして可視化する。
          status = "no_freight_charge";
          chargedFreight = 0;
          margin = 0 - line.amount;
        } else {
          // その受注番号の売上データ自体が無い(直近4か月に一件も無い) → まだ未売上等。
          // 判断材料が無いため空欄のままにする。
          status = "no_sales_data";
        }
      }

      // 2026-08-26追加: 受注番号が不明、または受注番号はあっても売上データから
      // 得意先名を当てられない(例: 末尾5桁が00000のような仮番号)場合は、得意先名の
      // 代わりに請求データ自体が持っている納品先名(会社ごとに異なる項目、無い場合は
      // 空欄のまま)を表示する。実際の得意先名と区別できるよう「(納品先)」を付ける。
      if (!customerName && line.destinationName) {
        customerName = `${line.destinationName}(納品先)`;
      }

      // 2026-09-02追加(運賃実績集計): 期間末日。福山通運・西濃運輸(東京本社)は
      // 行ごとに自動計算済み(line.periodEnd)。西濃運輸(標準)はファイル単位の
      // 手入力(seinoFilePeriodEnd)から引く。
      const periodEnd =
        line.carrier === "西濃運輸" ? seinoFilePeriodEnd[line.sourceFile] ?? null : line.periodEnd ?? null;

      return {
        key: `${line.carrier}-${line.waybillNo}-${i}`,
        carrier: line.carrier,
        waybillNo: line.waybillNo,
        dateLabel: line.dateLabel,
        deliveryLocation: line.deliveryLocation,
        orderNo,
        customerCode,
        customerName,
        branchCode,
        repCode,
        deliveryNoteNo,
        actualFreight: line.amount,
        chargedFreight,
        margin,
        status,
        periodEnd,
        sourceFile: line.sourceFile,
      };
    });
  }, [invoiceLines, mappingByWaybill, orderInfoByOrder, freightByOrder, seinoFilePeriodEnd]);

  // 西濃運輸(標準)のファイル一覧(締め日の手入力が必要なもの)。
  const seinoFileNames = useMemo(() => {
    return Array.from(new Set(invoiceLines.filter((l) => l.carrier === "西濃運輸").map((l) => l.sourceFile)));
  }, [invoiceLines]);

  // 2026-09-02追加(運賃実績集計): 20日締め期間×拠点/営業担当/得意先で集計する。
  // 期間末日が未確定(西濃運輸で締め日を未入力)の行は集計対象から除外し、件数を別途返す。
  const freightAggregation = useMemo(() => {
    type Group = {
      period_end: string;
      carrier: string;
      branch_code: string;
      rep_code: string;
      customer_code: string;
      customer_name: string;
      shipment_count: number;
      matched_count: number;
      no_freight_charge_count: number;
      no_sales_data_count: number;
      no_mapping_count: number;
      actual_freight: number;
      charged_freight: number;
      margin: number;
      source_files: Set<string>;
    };
    const groups = new Map<string, Group>();
    let unresolvedPeriodCount = 0;

    for (const r of results) {
      if (!r.periodEnd) {
        unresolvedPeriodCount++;
        continue;
      }
      const branch = r.branchCode ?? "";
      const rep = r.repCode ?? "";
      const custCode = r.customerCode ?? "";
      const custName = r.customerName ?? "";
      const key = `${r.periodEnd}__${r.carrier}__${branch}__${rep}__${custCode}__${custName}`;
      let g = groups.get(key);
      if (!g) {
        g = {
          period_end: r.periodEnd,
          carrier: r.carrier,
          branch_code: branch,
          rep_code: rep,
          customer_code: custCode,
          customer_name: custName,
          shipment_count: 0,
          matched_count: 0,
          no_freight_charge_count: 0,
          no_sales_data_count: 0,
          no_mapping_count: 0,
          actual_freight: 0,
          charged_freight: 0,
          margin: 0,
          source_files: new Set(),
        };
        groups.set(key, g);
      }
      g.shipment_count++;
      g.actual_freight += r.actualFreight;
      g.source_files.add(r.sourceFile);
      if (r.status === "matched") g.matched_count++;
      else if (r.status === "no_freight_charge") g.no_freight_charge_count++;
      else if (r.status === "no_sales_data") g.no_sales_data_count++;
      else g.no_mapping_count++;
      // 請求運賃・利益は、金額が判明する行(matched・no_freight_charge)だけ合算する
      // (画面上部のサマリーと同じ考え方。no_mapping/no_sales_dataは請求額不明のため含めない)。
      if (r.status === "matched" || r.status === "no_freight_charge") {
        g.charged_freight += r.chargedFreight ?? 0;
        g.margin += r.margin ?? 0;
      }
    }

    const rows = Array.from(groups.values())
      .map((g) => ({
        period_end: g.period_end,
        carrier: g.carrier,
        branch_code: g.branch_code,
        rep_code: g.rep_code,
        customer_code: g.customer_code,
        customer_name: g.customer_name,
        shipment_count: g.shipment_count,
        matched_count: g.matched_count,
        no_freight_charge_count: g.no_freight_charge_count,
        no_sales_data_count: g.no_sales_data_count,
        no_mapping_count: g.no_mapping_count,
        actual_freight: Math.round(g.actual_freight),
        charged_freight: Math.round(g.charged_freight),
        margin: Math.round(g.margin),
        source_files: Array.from(g.source_files).join(", "),
      }))
      .sort((a, b) => (a.period_end < b.period_end ? -1 : a.period_end > b.period_end ? 1 : 0));

    return { rows, unresolvedPeriodCount };
  }, [results]);

  async function saveFreightAggregation() {
    setFreightSaveState({ saving: true, saved: false, error: null, savedCount: null });
    try {
      const res = await fetch("/api/upload/freight-actual", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows: freightAggregation.rows }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setFreightSaveState({ saving: false, saved: false, error: json.error ?? res.statusText, savedCount: null });
        return;
      }
      setFreightSaveState({ saving: false, saved: true, error: null, savedCount: freightAggregation.rows.length });
    } catch (e) {
      setFreightSaveState({ saving: false, saved: false, error: String(e), savedCount: null });
    }
  }

  const summary = useMemo(() => {
    let totalActual = 0;
    let totalCharged = 0;
    let totalMargin = 0;
    let nMatched = 0;
    let nNoMapping = 0;
    let nNoFreightCharge = 0;
    let nNoSalesData = 0;
    let lossCount = 0;
    for (const r of results) {
      totalActual += r.actualFreight;
      // matched(運賃行あり)・no_freight_charge(運賃未請求)はどちらも請求運賃・利益が
      // 計算できる(後者は請求運賃=0円)ので、金額サマリーにはあわせて含める。
      if (r.status === "matched" || r.status === "no_freight_charge") {
        totalCharged += r.chargedFreight ?? 0;
        totalMargin += r.margin ?? 0;
        if ((r.margin ?? 0) < 0) lossCount++;
      }
      if (r.status === "matched") nMatched++;
      else if (r.status === "no_freight_charge") nNoFreightCharge++;
      else if (r.status === "no_sales_data") nNoSalesData++;
      else nNoMapping++;
    }
    return {
      totalActual,
      totalCharged,
      totalMargin,
      nMatched,
      nNoMapping,
      nNoFreightCharge,
      nNoSalesData,
      lossCount,
      total: results.length,
    };
  }, [results]);

  const filtered = useMemo(() => {
    if (statusFilter === "all") return results;
    return results.filter((r) => r.status === statusFilter);
  }, [results, statusFilter]);

  // 2026-08-27追加: 西濃運輸(東京本社)で受注番号が不明(管理番号が空欄で、
  // お問合せ番号だけでは当てられない)行だけを抜き出す。この一覧から選んだ行を
  // 西濃へのFAX依頼シートとして出力する。
  const seinoTokyoUnknown = useMemo(
    () => results.filter((r) => r.carrier === "西濃運輸(東京本社)" && r.status === "no_mapping"),
    [results]
  );

  function toggleFaxKey(key: string) {
    setSelectedFaxKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function selectAllFaxKeys() {
    setSelectedFaxKeys(new Set(seinoTokyoUnknown.map((r) => r.key)));
  }

  function clearFaxKeys() {
    setSelectedFaxKeys(new Set());
  }

  function csvEscape(v: unknown): string {
    const s = v === null || v === undefined ? "" : String(v);
    if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  }

  function downloadCsv() {
    const header = [
      "運送会社",
      "送り状番号(原票No)",
      "日付",
      "受注番号",
      "得意先名",
      "配達場所",
      "拠点番号",
      "営業担当",
      "売上番号(納品書番号)",
      "実費運賃",
      "得意先への請求運賃",
      "利益(請求-実費)",
      "状態",
    ];
    const statusLabel: Record<MatchStatus, string> = {
      matched: "照合済み",
      no_mapping: "対応する受注が見つからない",
      no_freight_charge: "運賃未請求(売上あり・請求漏れ)",
      no_sales_data: "売上データなし(未売上等)",
    };
    const lines = [header.map(csvEscape).join(",")];
    for (const r of filtered) {
      lines.push(
        [
          r.carrier,
          r.waybillNo,
          r.dateLabel,
          r.orderNo ?? "",
          r.customerName ?? "",
          r.deliveryLocation,
          r.branchCode ?? "",
          r.repCode ?? "",
          r.deliveryNoteNo ?? "",
          Math.round(r.actualFreight),
          r.chargedFreight !== null ? Math.round(r.chargedFreight) : "",
          r.margin !== null ? Math.round(r.margin) : "",
          statusLabel[r.status],
        ]
          .map(csvEscape)
          .join(",")
      );
    }
    const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    a.download = `運賃照合_${today}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // 2026-08-27追加: チェックした「受注番号不明」行を、西濃運輸へ送り状の控えを
  // FAXで取り寄せる依頼用紙として、本物のxlsxファイル(列幅・フォントサイズ・罫線を
  // 固定)で出力する。レイアウトは、ユーザーが手動で整えてくれたサンプル
  // (西濃東京_送り状控えFAX依頼_20260827.xlsx)と同じ値をそのまま使っている。
  // exceljsは動的import(必要になった時だけ読み込む)にして、通常の画面表示では
  // 読み込まれないようにしている。
  const [faxExportError, setFaxExportError] = useState<string | null>(null);
  const [faxExporting, setFaxExporting] = useState(false);

  async function downloadFaxRequestXlsx() {
    const targets = seinoTokyoUnknown.filter((r) => selectedFaxKeys.has(r.key));
    if (targets.length === 0) return;

    setFaxExporting(true);
    setFaxExportError(null);
    try {
      const ExcelJS = (await import("exceljs")).default;
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet("FAX依頼");

      // サンプル(西濃東京_送り状控えFAX依頼_20260827.xlsx)と同じ列幅。
      sheet.columns = [{ width: 14.125 }, { width: 16.25 }, { width: 15.0 }, { width: 24.25 }];

      const FONT_NAME = "游ゴシック";
      const thinBorder = { style: "thin" as const };
      const centerAlign = { horizontal: "center" as const, vertical: "middle" as const };

      sheet.getRow(1).height = 25.5;
      const titleCell = sheet.getCell("B1");
      titleCell.value = "西濃運輸㈱  御中";
      titleCell.font = { name: FONT_NAME, size: 16 };
      titleCell.alignment = { vertical: "middle" };
      titleCell.border = { bottom: thinBorder };

      function setPlainText(addr: string, text: string) {
        const cell = sheet.getCell(addr);
        cell.value = text;
        cell.font = { name: FONT_NAME, size: 11 };
      }

      setPlainText("D2", `送信先FAX:${SEINO_TOKYO_FAX_SEND_NUMBER}`);
      setPlainText("A3", "いつもお世話になります。");
      setPlainText("A4", "下記問い合わせ番号の送り状の控えをFAXお願いします。");
      setPlainText("A5", `返信先FAX:${SEINO_TOKYO_FAX_REPLY_NUMBER}`);

      const headerRow = 8;
      const headers = ["日付", "お問合せ番号", "得意先名(参考)", "配達場所(参考)"];
      headers.forEach((h, i) => {
        const cell = sheet.getCell(headerRow, i + 1);
        cell.value = h;
        cell.font = { name: FONT_NAME, size: 11 };
        cell.alignment = centerAlign;
        cell.border = { top: thinBorder, bottom: thinBorder, left: thinBorder, right: thinBorder };
      });

      targets.forEach((r, idx) => {
        const rowNum = headerRow + 1 + idx;
        const values = [r.dateLabel, r.waybillNo, r.customerName ?? "", r.deliveryLocation];
        values.forEach((v, colIdx) => {
          const cell = sheet.getCell(rowNum, colIdx + 1);
          cell.value = v;
          cell.font = { name: FONT_NAME, size: 11 };
          cell.alignment = centerAlign;
          cell.border = { top: thinBorder, bottom: thinBorder, left: thinBorder, right: thinBorder };
        });
      });

      const footerRow1 = headerRow + targets.length + 3;
      setPlainText(`A${footerRow1}`, SEINO_TOKYO_FAX_SENDER_LABEL);
      setPlainText(`A${footerRow1 + 1}`, `TEL:${SEINO_TOKYO_FAX_SENDER_TEL}`);

      const buffer = await workbook.xlsx.writeBuffer();
      const blob = new Blob([buffer], {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
      a.download = `西濃東京_送り状控えFAX依頼_${today}.xlsx`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setFaxExportError(e instanceof Error ? e.message : String(e));
    } finally {
      setFaxExporting(false);
    }
  }

  return (
    <div className="page">
      <h1>運賃照合</h1>
      <p className="subtitle">
        西濃運輸・福山通運の請求データ(実費運賃)を、事前に取り込んだ送り状番号↔受注番号の対応表(shipping_note_mapping)経由で自社の受注に変換し、得意先への運賃請求額(sales_linesの商品コード「99」運賃行)と突き合わせて、運賃で利益が取れているかを一覧にします(西濃運輸(東京本社)形式のみ、対応表を使わず「管理番号」列を受注番号として直接使います)。請求データはこの場で読み込むだけでSupabaseには保存されません。
      </p>

      <div className="card" style={{ marginBottom: 20 }}>
        <h2 style={{ marginTop: 0 }}>① 送り状番号↔受注番号の対応データ</h2>
        <p className="subtitle" style={{ margin: "0 0 8px" }}>
          「送り状問合せ」CSVから取り込み済みのデータです。取り込み・更新は
          <Link href="/upload" style={{ marginLeft: 4 }}>
            データ更新
          </Link>
          画面から行ってください(3か月分プールされ、古いデータは自動削除されます)。
        </p>
        <div style={{ fontSize: 13 }}>
          現在 {mappingRows.length.toLocaleString("ja-JP")} 件
          {mappingRows.length > 0 && (
            <>
              (発行日:{" "}
              {mappingRows
                .map((r) => r.issue_date)
                .filter((d): d is string => !!d)
                .sort()[0] ?? "―"}{" "}
              〜{" "}
              {
                mappingRows
                  .map((r) => r.issue_date)
                  .filter((d): d is string => !!d)
                  .sort()
                  .slice(-1)[0] ?? "―"
              }
              )
            </>
          )}
          をプールしています。
        </div>
      </div>

      <div
        className="card"
        style={{ marginBottom: 20 }}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragEnter={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={(e) => {
          e.preventDefault();
          setDragOver(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          if (e.dataTransfer.files && e.dataTransfer.files.length > 0) handleFiles(e.dataTransfer.files);
        }}
      >
        <h2 style={{ marginTop: 0 }}>② 運送会社の請求データ</h2>
        <p className="subtitle" style={{ margin: "0 0 12px" }}>
          西濃運輸・西濃運輸(東京本社)・福山通運いずれの請求CSVもドラッグ&ドロップまたは選択できます(ヘッダー行から自動判別)。複数ファイルをまとめて選択可能です。
        </p>
        <label
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 6,
            padding: "28px 12px",
            borderRadius: 8,
            border: dragOver ? "2px dashed var(--direct)" : "2px dashed var(--border, #d0d5dd)",
            background: dragOver ? "rgba(37, 99, 235, 0.06)" : "transparent",
            cursor: fileState.loading ? "default" : "pointer",
            textAlign: "center",
            transition: "border-color 0.1s, background 0.1s",
          }}
        >
          <span style={{ fontSize: 13, color: dragOver ? "var(--direct)" : undefined }}>
            {dragOver ? "ここにドロップ" : "ここに請求CSVをドラッグ&ドロップ、またはクリックして選択"}
          </span>
          <input
            type="file"
            accept=".csv"
            multiple
            disabled={fileState.loading}
            style={{ display: "none" }}
            onChange={(e) => {
              if (e.target.files && e.target.files.length > 0) handleFiles(e.target.files);
              e.target.value = "";
            }}
          />
        </label>
        {fileState.fileNames.length > 0 && (
          <div style={{ marginTop: 12, fontSize: 13 }}>
            <div>ファイル: {fileState.fileNames.join(", ")}</div>
            <div>読み込んだ請求行数: {invoiceLines.length.toLocaleString("ja-JP")}件</div>
          </div>
        )}
        {fileState.errors.length > 0 && (
          <div style={{ color: "var(--critical)", marginTop: 8, fontSize: 13 }}>
            <ul style={{ margin: "4px 0 0", paddingLeft: 20 }}>
              {fileState.errors.map((e, i) => (
                <li key={i}>{e}</li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {invoiceLines.length > 0 && (
        <>
          <div className="kpi-row">
            <div className="kpi-tile" style={{ cursor: "pointer" }} onClick={() => setStatusFilter("all")}>
              <div className="label">請求行数</div>
              <div className="value">{summary.total.toLocaleString("ja-JP")}</div>
            </div>
            <div className="kpi-tile" style={{ cursor: "pointer" }} onClick={() => setStatusFilter("matched")}>
              <div className="label">照合済み</div>
              <div className="value">{summary.nMatched.toLocaleString("ja-JP")}</div>
            </div>
            <div className="kpi-tile" style={{ cursor: "pointer" }} onClick={() => setStatusFilter("no_freight_charge")}>
              <div className="label">運賃未請求(売上あり)</div>
              <div className="value">{summary.nNoFreightCharge.toLocaleString("ja-JP")}</div>
            </div>
            <div className="kpi-tile" style={{ cursor: "pointer" }} onClick={() => setStatusFilter("no_sales_data")}>
              <div className="label">売上データなし(未売上等)</div>
              <div className="value">{summary.nNoSalesData.toLocaleString("ja-JP")}</div>
            </div>
            <div className="kpi-tile" style={{ cursor: "pointer" }} onClick={() => setStatusFilter("no_mapping")}>
              <div className="label">対応する受注が見つからない</div>
              <div className="value">{summary.nNoMapping.toLocaleString("ja-JP")}</div>
            </div>
          </div>

          <div className="card" style={{ marginBottom: 20 }}>
            <h2 style={{ marginTop: 0 }}>金額サマリー(照合済み・運賃未請求分)</h2>
            <p className="subtitle" style={{ margin: "0 0 8px" }}>
              「売上データなし(未売上等)」「対応する受注が見つからない」分は金額が判断できないため、以下には含めていません。
            </p>
            <table>
              <tbody>
                <tr>
                  <td>実費運賃合計(運送会社への支払額、請求データ全行)</td>
                  <td style={{ textAlign: "right" }}>{fmtYen(summary.totalActual)}</td>
                </tr>
                <tr>
                  <td>得意先への請求運賃合計(運賃未請求分は0円として計算)</td>
                  <td style={{ textAlign: "right" }}>{fmtYen(summary.totalCharged)}</td>
                </tr>
                <tr>
                  <td>
                    <strong>運賃利益合計(請求 − 実費)</strong>
                  </td>
                  <td
                    style={{
                      textAlign: "right",
                      fontWeight: "bold",
                      color: summary.totalMargin < 0 ? "var(--critical)" : "var(--good)",
                    }}
                  >
                    {fmtYen(summary.totalMargin)}
                  </td>
                </tr>
                <tr>
                  <td>うち赤字(請求額が実費を下回る)件数</td>
                  <td style={{ textAlign: "right", color: summary.lossCount > 0 ? "var(--critical)" : undefined }}>
                    {summary.lossCount.toLocaleString("ja-JP")}件
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <div className="card" style={{ marginBottom: 20 }}>
            <h2 style={{ marginTop: 0 }}>運賃実績集計(拠点/営業担当/得意先 × 20日締め期間)</h2>
            <p className="subtitle" style={{ margin: "0 0 8px" }}>
              日次の明細ではなく、20日締め期間(例: 11/21〜12/20分を「2025-12-20」として扱う)ごとに拠点/営業担当/得意先で集計してから保存します。福山通運は10日締めですが、行ごとの実際の発送日から自動で20日締め期間に振り分けます(月をまたぐ請求は自動的に2期間に分かれます)。西濃運輸(標準)は行に年が印字されないため、下で締め日を指定してください。
            </p>

            {seinoFileNames.length > 0 && (
              <div style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 13, marginBottom: 6 }}>西濃運輸(標準)ファイルの締め日(20日締め期間の末日)</div>
                {seinoFileNames.map((fname) => (
                  <div key={fname} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6, fontSize: 13 }}>
                    <span style={{ minWidth: 260, wordBreak: "break-all" }}>{fname}</span>
                    <input
                      type="date"
                      value={seinoFilePeriodEnd[fname] ?? ""}
                      onChange={(e) =>
                        setSeinoFilePeriodEnd((prev) => ({ ...prev, [fname]: e.target.value }))
                      }
                      style={{ padding: "4px 8px", border: "1px solid var(--border)", borderRadius: 4 }}
                    />
                    {!seinoFilePeriodEnd[fname] && (
                      <span style={{ color: "var(--critical)" }}>未入力(このファイルの行は集計に含まれません)</span>
                    )}
                  </div>
                ))}
              </div>
            )}

            {freightAggregation.unresolvedPeriodCount > 0 && (
              <p style={{ color: "var(--critical)", fontSize: 13, marginBottom: 8 }}>
                締め日未確定のため{freightAggregation.unresolvedPeriodCount.toLocaleString("ja-JP")}件が集計から除外されています。上の締め日を入力してください。
              </p>
            )}

            <p style={{ fontSize: 13, marginBottom: 8 }}>
              集計結果: {freightAggregation.rows.length.toLocaleString("ja-JP")}グループ(期間×運送会社×拠点×営業×得意先)
            </p>

            {freightAggregation.rows.length > 0 && (
              <div className="table-scroll" style={{ marginBottom: 12 }}>
                <table>
                  <thead>
                    <tr>
                      <th>期間(締め日)</th>
                      <th>運送会社</th>
                      <th>拠点</th>
                      <th>営業担当</th>
                      <th>得意先</th>
                      <th className="num">件数</th>
                      <th className="num">実費運賃</th>
                      <th className="num">請求運賃</th>
                      <th className="num">利益</th>
                    </tr>
                  </thead>
                  <tbody>
                    {freightAggregation.rows.map((g, i) => (
                      <tr key={i}>
                        <td>{g.period_end}</td>
                        <td>{g.carrier}</td>
                        <td>{g.branch_code || "不明"}</td>
                        <td>{g.rep_code || "不明"}</td>
                        <td>{g.customer_name || "不明"}</td>
                        <td className="num">{g.shipment_count.toLocaleString("ja-JP")}</td>
                        <td className="num">{fmtYen(g.actual_freight)}</td>
                        <td className="num">{fmtYen(g.charged_freight)}</td>
                        <td className="num" style={{ color: g.margin < 0 ? "var(--critical)" : undefined }}>
                          {fmtYen(g.margin)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <button
              onClick={saveFreightAggregation}
              disabled={freightAggregation.rows.length === 0 || freightSaveState.saving}
              style={{
                padding: "8px 20px",
                borderRadius: 6,
                border: "1px solid var(--direct)",
                background: freightAggregation.rows.length === 0 || freightSaveState.saving ? "#c3d6f8" : "var(--direct)",
                color: "#fff",
                cursor: freightAggregation.rows.length === 0 || freightSaveState.saving ? "not-allowed" : "pointer",
              }}
            >
              {freightSaveState.saving ? "保存中…" : "この集計をDBに保存(拠点/営業/得意先別の利益計算用)"}
            </button>
            <p className="cell-sub" style={{ marginTop: 6 }}>
              同じ期間×運送会社の組み合わせを再保存すると、その分は上書き(洗い替え)されます。
            </p>
            {freightSaveState.saved && (
              <p style={{ color: "var(--good)", marginTop: 6 }}>
                保存しました({freightSaveState.savedCount?.toLocaleString("ja-JP")}グループ)。
              </p>
            )}
            {freightSaveState.error && (
              <p style={{ color: "var(--critical)", marginTop: 6 }}>保存に失敗しました: {freightSaveState.error}</p>
            )}
          </div>

          {seinoTokyoUnknown.length > 0 && (
            <div className="card" style={{ marginBottom: 20 }}>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  marginBottom: 8,
                  flexWrap: "wrap",
                  gap: 8,
                }}
              >
                <h2 style={{ margin: 0 }}>
                  西濃運輸(東京本社) 受注番号不明分({seinoTokyoUnknown.length.toLocaleString("ja-JP")}件)
                </h2>
                <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  <button className="ghost-btn" onClick={selectAllFaxKeys}>
                    全選択
                  </button>
                  <button className="ghost-btn" onClick={clearFaxKeys}>
                    選択解除
                  </button>
                  <button
                    className="ghost-btn"
                    onClick={downloadFaxRequestXlsx}
                    disabled={selectedFaxKeys.size === 0 || faxExporting}
                  >
                    {faxExporting
                      ? "作成中…"
                      : `選択した${selectedFaxKeys.size}件を西濃FAX依頼用Excelで出力`}
                  </button>
                </div>
              </div>
              <p className="subtitle" style={{ margin: "0 0 8px" }}>
                管理番号(自社受注番号)が空欄で、売上データからは当てられない行です。チェックした行を、西濃運輸に送り状の控えをFAXで取り寄せる依頼用紙(Excel、列幅・文字サイズ固定)として出力できます。
              </p>
              {faxExportError && (
                <p style={{ color: "var(--critical)", fontSize: 13, margin: "0 0 8px" }}>
                  Excelの作成に失敗しました: {faxExportError}
                </p>
              )}
              <div className="table-scroll table-scroll-v">
                <table>
                  <thead>
                    <tr>
                      <th style={{ width: 32 }}></th>
                      <th>受付日</th>
                      <th>お問合せ番号</th>
                      <th>得意先名(納品先)</th>
                      <th>配達場所</th>
                      <th style={{ textAlign: "right" }}>実費運賃</th>
                    </tr>
                  </thead>
                  <tbody>
                    {seinoTokyoUnknown.map((r) => (
                      <tr key={r.key}>
                        <td>
                          <input
                            type="checkbox"
                            checked={selectedFaxKeys.has(r.key)}
                            onChange={() => toggleFaxKey(r.key)}
                          />
                        </td>
                        <td>{r.dateLabel}</td>
                        <td>{r.waybillNo}</td>
                        <td>{r.customerName ?? "―"}</td>
                        <td>{r.deliveryLocation || "―"}</td>
                        <td style={{ textAlign: "right" }}>{fmtYen(r.actualFreight)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <div className="card">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
              <h2 style={{ margin: 0 }}>
                明細一覧
                {statusFilter !== "all" && (
                  <button className="ghost-btn" style={{ marginLeft: 12, fontSize: 12 }} onClick={() => setStatusFilter("all")}>
                    絞り込み解除
                  </button>
                )}
              </h2>
              <button className="ghost-btn" onClick={downloadCsv} disabled={filtered.length === 0}>
                この一覧をCSVでダウンロード
              </button>
            </div>
            <div className="table-scroll table-scroll-v">
              <table>
                <thead>
                  <tr>
                    <th>運送会社</th>
                    <th>送り状番号</th>
                    <th>日付</th>
                    <th>受注番号</th>
                    <th>得意先名</th>
                    <th>配達場所</th>
                    <th>拠点番号</th>
                    <th>営業担当</th>
                    <th>売上番号</th>
                    <th style={{ textAlign: "right" }}>実費運賃</th>
                    <th style={{ textAlign: "right" }}>請求運賃</th>
                    <th style={{ textAlign: "right" }}>利益</th>
                    <th>状態</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((r) => (
                    <tr key={r.key}>
                      <td>{r.carrier}</td>
                      <td>{r.waybillNo}</td>
                      <td>{r.dateLabel}</td>
                      <td>{r.orderNo ?? "―"}</td>
                      <td>{r.customerName ?? "―"}</td>
                      <td>{r.deliveryLocation || "―"}</td>
                      <td>{r.branchCode ?? "―"}</td>
                      <td>{r.repCode ?? "―"}</td>
                      <td>{r.deliveryNoteNo ?? "―"}</td>
                      <td style={{ textAlign: "right" }}>{fmtYen(r.actualFreight)}</td>
                      <td style={{ textAlign: "right" }}>{fmtYen(r.chargedFreight)}</td>
                      <td
                        style={{
                          textAlign: "right",
                          color: r.margin !== null && r.margin < 0 ? "var(--critical)" : undefined,
                        }}
                      >
                        {fmtYen(r.margin)}
                      </td>
                      <td>
                        {r.status === "matched" && <span className="badge good">照合済み</span>}
                        {r.status === "no_freight_charge" && <span className="badge critical">運賃未請求(売上あり)</span>}
                        {r.status === "no_sales_data" && <span className="badge neutral">売上データなし(未売上等)</span>}
                        {r.status === "no_mapping" && <span className="badge neutral">対応する受注なし</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      <div style={{ marginTop: 20 }}>
        <Link
          href="/benrinet-check"
          className="ghost-btn"
          style={{ display: "inline-block", textDecoration: "none", marginRight: 10 }}
        >
          べんりネット照合
        </Link>
        <Link
          href="/payable-check"
          className="ghost-btn"
          style={{ display: "inline-block", textDecoration: "none", marginRight: 10 }}
        >
          買掛月報照合
        </Link>
        <Link
          href="/life-check"
          className="ghost-btn"
          style={{ display: "inline-block", textDecoration: "none", marginRight: 10 }}
        >
          ライフ照合
        </Link>
        <Link
          href="/life-billing-check"
          className="ghost-btn"
          style={{ display: "inline-block", textDecoration: "none", marginRight: 10 }}
        >
          ライフ請求金額照合
        </Link>
        <Link href="/menu" className="ghost-btn" style={{ display: "inline-block", textDecoration: "none" }}>
          ← メニューに戻る
        </Link>
      </div>
    </div>
  );
}
