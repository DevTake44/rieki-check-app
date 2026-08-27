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
 */

type Carrier = "西濃運輸" | "福山通運" | "西濃運輸(東京本社)";

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
};

type MatchStatus = "matched" | "no_mapping" | "no_freight_charge" | "no_sales_data";

type ResultRow = {
  key: string;
  carrier: Carrier;
  waybillNo: string;
  dateLabel: string;
  deliveryLocation: string;
  orderNo: string | null;
  customerName: string | null;
  branchCode: string | null;
  repCode: string | null;
  deliveryNoteNo: string | null;
  actualFreight: number;
  chargedFreight: number | null;
  margin: number | null;
  status: MatchStatus;
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
      { branchCode: string | null; repCode: string | null; deliveryNoteNo: string | null; customerName: string | null }
    >();
    for (const l of freightSalesLines) {
      if (!l.order_no) continue;
      const prev = m.get(l.order_no);
      m.set(l.order_no, {
        branchCode: prev?.branchCode ?? l.branch_code,
        repCode: prev?.repCode ?? l.rep_code,
        deliveryNoteNo: prev?.deliveryNoteNo ?? l.delivery_note_no,
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
  }

  const results: ResultRow[] = useMemo(() => {
    return invoiceLines.map((line, i) => {
      // 西濃運輸(東京本社)は送り状番号↔受注番号の対応表を経由せず、管理番号を
      // そのまま受注番号として使う(directOrderNoが設定されている場合はそちら優先)。
      const mapRow = mappingByWaybill.get(line.waybillNo);
      const orderNo = line.directOrderNo ?? mapRow?.order_no ?? null;
      let status: MatchStatus;
      let chargedFreight: number | null = null;
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

      return {
        key: `${line.carrier}-${line.waybillNo}-${i}`,
        carrier: line.carrier,
        waybillNo: line.waybillNo,
        dateLabel: line.dateLabel,
        deliveryLocation: line.deliveryLocation,
        orderNo,
        customerName,
        branchCode,
        repCode,
        deliveryNoteNo,
        actualFreight: line.amount,
        chargedFreight,
        margin,
        status,
      };
    });
  }, [invoiceLines, mappingByWaybill, orderInfoByOrder, freightByOrder]);

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
