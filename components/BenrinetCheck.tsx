"use client";

import { useMemo, useState } from "react";
import Papa from "papaparse";

/**
 * べんりネット照合ダッシュボード
 *
 * 「べんりネット」(取引先の受発注ポータル)から出力したCSVと、自社の請求出力CSVを
 * 1画面にアップロードし、その場で(サーバーに送らず、ブラウザ内だけで)突き合わせて
 * 差異を表示する。データはどこにも保存しない(その場限りの照合)。
 *
 * ■ べんりネットCSV(D31形式)について
 * ヘッダー行が無く、1行目は「総件数」だけが入った行(例: "0000274,")。
 * 2行目以降が実データで、1行=89列の固定フォーマット。列名の定義書が手元に無いため、
 * 2026年8月時点で実際にアップロードされたサンプルCSVと、同時期の自社請求出力CSVを
 * 突き合わせて列の意味を特定した(以下の列番号はすべて0始まり)。
 *   [5]  客先注番   … 取引先(得意先)側の発注番号。自社請求データの「客先注番」と一致する
 *   [6]  受注日     … YYYYMMDD
 *   [7]  納品日     … YYYYMMDD
 *   [20] 店舗名     … 例:「【０００８】ドン・キホーテ新宿店」
 *   [41] 明細行番号 … 客先注番の中の行番号。自社請求データの「受注行番号」と一致する
 *   [43] 品番       … 取引先側の商品コード(自社の品番とは体系が異なるため照合キーにはしない)
 *   [45] 品名       … 空のときは[50]に同じ値が入っていることがあるため両方見る
 *   [54] 数量
 *   [57] 単価
 *   (金額を表す列は無いため、 数量×単価 で算出する)
 *
 * サンプルデータで実際に検証した結果、客先注番+明細行番号をキーにして突き合わせると、
 * 一致する265件超のうち「数量×単価(=金額)」は1件残らず一致していた。数量や単価の
 * 内訳(例: べんりネット側は1個1,700円、自社側は2個850円)が違っていても金額は一致する
 * ケースがあり、これは単位の数え方の違いであって実害のある差異ではないため、
 * 「一致(内訳相違)」として金額不一致とは区別して表示する。
 *
 * ■ 自社請求出力CSVについて
 * ヘッダー行あり、Shift_JIS。今回の照合で使う列は以下(列名で参照するので順序は問わない):
 *   客先注番, 受注番号, 受注行番号, 受注年月日, 納品年月日, 品番, 品名,
 *   受注総数量, 販売単価, 金額, 得意先名１, 件名
 *
 * ■ 客先注番が空の請求データについて
 * サンプルデータの中に、本来べんりネット側の注文と対応するはずなのに客先注番が
 * 空欄のまま請求データに載っている行が実在した(入力漏れの可能性)。空欄同士を
 * キーにして突き合わせると無関係な行が偶然一致したことになりかねないため、
 * 客先注番が空の行は自動照合の対象から外し、「客先注番未入力」として別枠で
 * 一覧表示し、目視確認を促す。
 */

type BenrinetRecord = {
  key: string;
  customerOrderNo: string;
  lineNo: string;
  itemName: string;
  qty: number;
  unitPrice: number;
  amount: number;
  orderDate: string;
  deliveryDate: string;
  storeName: string;
};

type InvoiceRecord = {
  key: string;
  customerOrderNo: string;
  lineNo: string;
  orderNo: string;
  itemName: string;
  qty: number;
  unitPrice: number;
  amount: number;
  orderDate: string;
  deliveryDate: string;
  customerName: string;
  subject: string;
};

type FileState = {
  fileName: string;
  encoding: string;
  loading: boolean;
  error: string | null;
};

function initialFileState(): FileState {
  return { fileName: "", encoding: "", loading: false, error: null };
}

/**
 * UTF-8 / Shift_JIS(CP932) を自動判定して読み込む。
 * (components/UploadForm.tsx の readFileSmart と同じ判定ロジック)
 */
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

function fmtDate(yyyymmdd: string): string {
  const s = (yyyymmdd || "").trim();
  if (!/^\d{8}$/.test(s)) return s;
  return `${s.slice(0, 4)}/${s.slice(4, 6)}/${s.slice(6, 8)}`;
}

function fmtYen(n: number | null): string {
  if (n === null || Number.isNaN(n)) return "―";
  return `¥${Math.round(n).toLocaleString("ja-JP")}`;
}

function csvEscape(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toNum(s: string | undefined): number {
  if (!s) return 0;
  const n = parseFloat(s.trim());
  return Number.isFinite(n) ? n : 0;
}

function parseBenrinetCsv(text: string): { records: BenrinetRecord[]; warnings: string[] } {
  const parsed = Papa.parse<string[]>(text, { skipEmptyLines: true });
  const rows = parsed.data;
  const warnings: string[] = [];
  if (rows.length < 2) {
    return { records: [], warnings: ["データ行が見つかりませんでした(1行目の件数行しかありません)。"] };
  }
  const declaredCount = parseInt((rows[0][0] || "").trim(), 10);
  const dataRows = rows.slice(1).filter((r) => r.length >= 58 && (r[5] || "").trim() !== "");

  if (dataRows.length === 0) {
    return {
      records: [],
      warnings: ["読み込める形式のデータ行が1件もありませんでした。べんりネットのCSVで間違いないか確認してください。"],
    };
  }
  if (Number.isFinite(declaredCount) && declaredCount !== dataRows.length) {
    warnings.push(
      `1行目に記載の件数(${declaredCount.toLocaleString("ja-JP")}件)と、実際に読み込めた行数(${dataRows.length.toLocaleString(
        "ja-JP"
      )}件)が一致しません。ファイルが途中で切れていないか確認してください。`
    );
  }

  const records: BenrinetRecord[] = dataRows.map((r) => {
    const customerOrderNo = (r[5] || "").trim();
    const lineNo = (r[41] || "").trim();
    const qty = toNum(r[54]);
    const unitPrice = toNum(r[57]);
    return {
      key: `${customerOrderNo}__${lineNo}`,
      customerOrderNo,
      lineNo,
      itemName: (r[45] || "").trim() || (r[50] || "").trim(),
      qty,
      unitPrice,
      amount: qty * unitPrice,
      orderDate: (r[6] || "").trim(),
      deliveryDate: (r[7] || "").trim(),
      storeName: (r[20] || "").trim(),
    };
  });
  return { records, warnings };
}

function parseInvoiceCsv(text: string): { records: InvoiceRecord[]; warnings: string[] } {
  const parsed = Papa.parse<Record<string, string>>(text, { header: true, skipEmptyLines: true });
  const warnings: string[] = [];
  const requiredCols = ["客先注番", "受注行番号", "受注総数量", "販売単価", "金額"];
  const fields = parsed.meta.fields || [];
  const missing = requiredCols.filter((c) => !fields.includes(c));
  if (missing.length > 0) {
    return {
      records: [],
      warnings: [`必要な列が見つかりませんでした: ${missing.join("、")}。自社の請求出力CSVで間違いないか確認してください。`],
    };
  }

  const records: InvoiceRecord[] = parsed.data
    .filter((row) => (row["受注番号"] || "").trim() !== "" || (row["品名"] || "").trim() !== "")
    .map((row) => {
      const customerOrderNo = (row["客先注番"] || "").trim();
      const lineNo = (row["受注行番号"] || "").trim();
      return {
        key: `${customerOrderNo}__${lineNo}`,
        customerOrderNo,
        lineNo,
        orderNo: (row["受注番号"] || "").trim(),
        itemName: (row["品名"] || "").trim(),
        qty: toNum(row["受注総数量"]),
        unitPrice: toNum(row["販売単価"]),
        amount: toNum(row["金額"]),
        orderDate: (row["受注年月日"] || "").trim(),
        deliveryDate: (row["納品年月日"] || "").trim(),
        customerName: (row["得意先名１"] || "").trim(),
        subject: (row["件名"] || "").trim(),
      };
    });

  if (records.length === 0) {
    warnings.push("読み込める形式のデータ行が1件もありませんでした。");
  }
  return { records, warnings };
}

type Status = "amount_mismatch" | "detail_diff" | "match" | "benrinet_only" | "invoice_only";

type ReconcileRow = {
  key: string;
  customerOrderNo: string;
  lineNo: string;
  status: Status;
  benrinet: BenrinetRecord | null;
  invoice: InvoiceRecord | null;
  diff: number;
};

const STATUS_ORDER: Status[] = ["amount_mismatch", "benrinet_only", "invoice_only", "detail_diff", "match"];
const STATUS_LABEL: Record<Status, string> = {
  amount_mismatch: "金額相違",
  detail_diff: "一致(内訳相違)",
  match: "一致",
  benrinet_only: "べんりネットのみ",
  invoice_only: "自社請求のみ",
};
const STATUS_BADGE_CLASS: Record<Status, string> = {
  amount_mismatch: "badge critical",
  detail_diff: "badge neutral",
  match: "badge good",
  benrinet_only: "badge warning",
  invoice_only: "badge warning",
};

function groupByKey<T extends { key: string; amount: number; qty: number }>(records: T[]): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const r of records) {
    const arr = map.get(r.key);
    if (arr) arr.push(r);
    else map.set(r.key, [r]);
  }
  return map;
}

export default function BenrinetCheck() {
  const [benrinetState, setBenrinetState] = useState<FileState>(initialFileState());
  const [invoiceState, setInvoiceState] = useState<FileState>(initialFileState());
  const [benrinetRecords, setBenrinetRecords] = useState<BenrinetRecord[]>([]);
  const [invoiceRecords, setInvoiceRecords] = useState<InvoiceRecord[]>([]);
  const [benrinetWarnings, setBenrinetWarnings] = useState<string[]>([]);
  const [invoiceWarnings, setInvoiceWarnings] = useState<string[]>([]);
  const [statusFilter, setStatusFilter] = useState<Status | "all">("all");
  const [search, setSearch] = useState("");

  async function handleBenrinetFile(file: File) {
    setBenrinetState({ ...initialFileState(), fileName: file.name, loading: true });
    try {
      const { text, encoding } = await readFileSmart(file);
      const { records, warnings } = parseBenrinetCsv(text);
      setBenrinetRecords(records);
      setBenrinetWarnings(warnings);
      setBenrinetState({
        fileName: file.name,
        encoding,
        loading: false,
        error: records.length === 0 ? warnings[0] || "読み込みに失敗しました。" : null,
      });
    } catch (e) {
      setBenrinetRecords([]);
      setBenrinetState({ fileName: file.name, encoding: "", loading: false, error: String(e) });
    }
  }

  async function handleInvoiceFile(file: File) {
    setInvoiceState({ ...initialFileState(), fileName: file.name, loading: true });
    try {
      const { text, encoding } = await readFileSmart(file);
      const { records, warnings } = parseInvoiceCsv(text);
      setInvoiceRecords(records);
      setInvoiceWarnings(warnings);
      setInvoiceState({
        fileName: file.name,
        encoding,
        loading: false,
        error: records.length === 0 ? warnings[0] || "読み込みに失敗しました。" : null,
      });
    } catch (e) {
      setInvoiceRecords([]);
      setInvoiceState({ fileName: file.name, encoding: "", loading: false, error: String(e) });
    }
  }

  function reset() {
    setBenrinetState(initialFileState());
    setInvoiceState(initialFileState());
    setBenrinetRecords([]);
    setInvoiceRecords([]);
    setBenrinetWarnings([]);
    setInvoiceWarnings([]);
    setStatusFilter("all");
    setSearch("");
  }

  const { rows, invoiceMissingKey, benrinetMissingKey, summary } = useMemo(() => {
    const benrinetUsable = benrinetRecords.filter((r) => r.customerOrderNo !== "");
    const invoiceUsable = invoiceRecords.filter((r) => r.customerOrderNo !== "");
    const benrinetMissingKey = benrinetRecords.filter((r) => r.customerOrderNo === "");
    const invoiceMissingKey = invoiceRecords.filter((r) => r.customerOrderNo === "");

    const bMap = groupByKey(benrinetUsable);
    const iMap = groupByKey(invoiceUsable);
    const keys = new Set<string>([...bMap.keys(), ...iMap.keys()]);

    const out: ReconcileRow[] = [];
    keys.forEach((key) => {
      const bList = bMap.get(key);
      const iList = iMap.get(key);
      const [customerOrderNo, lineNo] = key.split("__");

      const b: BenrinetRecord | null = bList
        ? {
            ...bList[0],
            qty: bList.reduce((s, x) => s + x.qty, 0),
            amount: bList.reduce((s, x) => s + x.amount, 0),
          }
        : null;
      const i: InvoiceRecord | null = iList
        ? {
            ...iList[0],
            qty: iList.reduce((s, x) => s + x.qty, 0),
            amount: iList.reduce((s, x) => s + x.amount, 0),
          }
        : null;

      let status: Status;
      let diff = 0;
      if (b && i) {
        diff = i.amount - b.amount;
        if (Math.abs(diff) >= 1) {
          status = "amount_mismatch";
        } else if (Math.abs(i.qty - b.qty) >= 0.001 || Math.abs(i.unitPrice - b.unitPrice) >= 1) {
          status = "detail_diff";
        } else {
          status = "match";
        }
      } else if (b) {
        status = "benrinet_only";
        diff = -b.amount;
      } else {
        status = "invoice_only";
        diff = i!.amount;
      }

      out.push({ key, customerOrderNo, lineNo, status, benrinet: b, invoice: i, diff });
    });

    out.sort((a, b) => {
      const oa = STATUS_ORDER.indexOf(a.status);
      const ob = STATUS_ORDER.indexOf(b.status);
      if (oa !== ob) return oa - ob;
      return a.customerOrderNo.localeCompare(b.customerOrderNo) || a.lineNo.localeCompare(b.lineNo);
    });

    const summary = {
      total: out.length,
      match: out.filter((r) => r.status === "match").length,
      detailDiff: out.filter((r) => r.status === "detail_diff").length,
      amountMismatch: out.filter((r) => r.status === "amount_mismatch").length,
      benrinetOnly: out.filter((r) => r.status === "benrinet_only").length,
      invoiceOnly: out.filter((r) => r.status === "invoice_only").length,
      amountMismatchTotal: out
        .filter((r) => r.status === "amount_mismatch")
        .reduce((s, r) => s + r.diff, 0),
    };

    return { rows: out, invoiceMissingKey, benrinetMissingKey, summary };
  }, [benrinetRecords, invoiceRecords]);

  const filteredRows = useMemo(() => {
    let r = rows;
    if (statusFilter !== "all") r = r.filter((x) => x.status === statusFilter);
    if (search.trim()) {
      const s = search.trim().toLowerCase();
      r = r.filter((x) => {
        const hay = `${x.customerOrderNo} ${x.benrinet?.itemName ?? ""} ${x.invoice?.itemName ?? ""} ${
          x.invoice?.customerName ?? ""
        } ${x.invoice?.orderNo ?? ""} ${x.benrinet?.storeName ?? ""}`.toLowerCase();
        return hay.includes(s);
      });
    }
    return r;
  }, [rows, statusFilter, search]);

  function downloadCsv() {
    if (!rows.length) return;
    const headers = [
      "照合結果",
      "客先注番",
      "行番号",
      "べんりネット_品名",
      "べんりネット_数量",
      "べんりネット_単価",
      "べんりネット_金額",
      "べんりネット_納品日",
      "自社_受注番号",
      "自社_品名",
      "自社_数量",
      "自社_単価",
      "自社_金額",
      "自社_得意先名",
      "自社_件名",
      "差額(自社-べんりネット)",
    ];
    const lines = [headers.map(csvEscape).join(",")];
    rows.forEach((r) => {
      lines.push(
        [
          STATUS_LABEL[r.status],
          r.customerOrderNo,
          r.lineNo,
          r.benrinet?.itemName ?? "",
          r.benrinet?.qty ?? "",
          r.benrinet?.unitPrice ?? "",
          r.benrinet?.amount ?? "",
          fmtDate(r.benrinet?.deliveryDate ?? ""),
          r.invoice?.orderNo ?? "",
          r.invoice?.itemName ?? "",
          r.invoice?.qty ?? "",
          r.invoice?.unitPrice ?? "",
          r.invoice?.amount ?? "",
          r.invoice?.customerName ?? "",
          r.invoice?.subject ?? "",
          r.benrinet && r.invoice ? Math.round(r.diff) : "",
        ]
          .map(csvEscape)
          .join(",")
      );
    });
    const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `べんりネット照合結果_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const bothLoaded = benrinetRecords.length > 0 && invoiceRecords.length > 0;

  return (
    <div className="page">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 12 }}>
        <div>
          <h1>べんりネット照合</h1>
          <p className="subtitle">
            べんりネットのCSVと自社の請求出力CSVをこの画面にアップロードすると、その場で(サーバーに送信せず)突き合わせて差異を表示します。客先注番+行番号をキーに照合しています。
          </p>
        </div>
        <div style={{ display: "flex", gap: 10, marginTop: 4 }}>
          <a href="/profit" className="ghost-btn" style={{ textDecoration: "none" }}>
            売上利益
          </a>
          <a href="/internal-transfer" className="ghost-btn" style={{ textDecoration: "none" }}>
            社内間金額
          </a>
          <a href="/upload" className="ghost-btn" style={{ textDecoration: "none" }}>
            データ更新
          </a>
          <a href="/" className="ghost-btn" style={{ textDecoration: "none" }}>
            ← 値上げ検知ダッシュボードへ
          </a>
        </div>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
          gap: 12,
          marginBottom: 20,
          marginTop: 4,
        }}
      >
        <div className="card">
          <h2 style={{ marginTop: 0, fontSize: 16 }}>① べんりネットCSV</h2>
          <input
            type="file"
            accept=".csv"
            disabled={benrinetState.loading}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) handleBenrinetFile(f);
              e.target.value = "";
            }}
          />
          {benrinetState.fileName && (
            <div style={{ marginTop: 10, fontSize: 12.5 }}>
              <div>ファイル: {benrinetState.fileName}</div>
              {benrinetState.encoding && <div className="cell-sub">文字コード: {benrinetState.encoding}</div>}
              {benrinetState.loading && <div style={{ color: "var(--direct)" }}>読み込み中…</div>}
              {!benrinetState.loading && benrinetRecords.length > 0 && (
                <div style={{ color: "var(--good)" }}>{benrinetRecords.length.toLocaleString("ja-JP")}件を読み込みました</div>
              )}
              {benrinetState.error && <div style={{ color: "var(--critical)" }}>{benrinetState.error}</div>}
              {benrinetWarnings.map((w, i) => (
                <div key={i} style={{ color: "var(--warning)" }}>
                  {w}
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="card">
          <h2 style={{ marginTop: 0, fontSize: 16 }}>② 自社請求データCSV</h2>
          <input
            type="file"
            accept=".csv"
            disabled={invoiceState.loading}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) handleInvoiceFile(f);
              e.target.value = "";
            }}
          />
          {invoiceState.fileName && (
            <div style={{ marginTop: 10, fontSize: 12.5 }}>
              <div>ファイル: {invoiceState.fileName}</div>
              {invoiceState.encoding && <div className="cell-sub">文字コード: {invoiceState.encoding}</div>}
              {invoiceState.loading && <div style={{ color: "var(--direct)" }}>読み込み中…</div>}
              {!invoiceState.loading && invoiceRecords.length > 0 && (
                <div style={{ color: "var(--good)" }}>{invoiceRecords.length.toLocaleString("ja-JP")}件を読み込みました</div>
              )}
              {invoiceState.error && <div style={{ color: "var(--critical)" }}>{invoiceState.error}</div>}
              {invoiceWarnings.map((w, i) => (
                <div key={i} style={{ color: "var(--warning)" }}>
                  {w}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {(benrinetRecords.length > 0 || invoiceRecords.length > 0) && (
        <div className="filter-actions" style={{ marginTop: -8, marginBottom: 20 }}>
          <button className="ghost-btn" onClick={reset}>
            リセット
          </button>
        </div>
      )}

      {bothLoaded && (
        <>
          <div className="kpi-row">
            <div className="kpi-tile" style={{ cursor: "pointer" }} onClick={() => setStatusFilter("all")}>
              <div className="label">照合件数(合計)</div>
              <div className="value">{summary.total.toLocaleString("ja-JP")}</div>
            </div>
            <div className="kpi-tile" style={{ cursor: "pointer" }} onClick={() => setStatusFilter("amount_mismatch")}>
              <div className="label">金額相違</div>
              <div className="value" style={{ color: summary.amountMismatch > 0 ? "var(--critical)" : undefined }}>
                {summary.amountMismatch.toLocaleString("ja-JP")}
              </div>
            </div>
            <div className="kpi-tile" style={{ cursor: "pointer" }} onClick={() => setStatusFilter("benrinet_only")}>
              <div className="label">べんりネットのみ</div>
              <div className="value" style={{ color: summary.benrinetOnly > 0 ? "var(--warning)" : undefined }}>
                {summary.benrinetOnly.toLocaleString("ja-JP")}
              </div>
            </div>
            <div className="kpi-tile" style={{ cursor: "pointer" }} onClick={() => setStatusFilter("invoice_only")}>
              <div className="label">自社請求のみ</div>
              <div className="value" style={{ color: summary.invoiceOnly > 0 ? "var(--warning)" : undefined }}>
                {summary.invoiceOnly.toLocaleString("ja-JP")}
              </div>
            </div>
          </div>

          {summary.amountMismatch > 0 && (
            <div className="card" style={{ marginBottom: 20, padding: "12px 16px", background: "rgba(192,57,43,0.06)" }}>
              <span className="badge critical">要確認</span>
              <span style={{ marginLeft: 8 }}>
                金額が一致しない行が{summary.amountMismatch.toLocaleString("ja-JP")}件あります(差額合計
                {fmtYen(summary.amountMismatchTotal)}、自社金額-べんりネット金額)。
              </span>
            </div>
          )}

          {(benrinetMissingKey.length > 0 || invoiceMissingKey.length > 0) && (
            <div className="card" style={{ marginBottom: 20, padding: "12px 16px", background: "rgba(220,180,40,0.08)" }}>
              <span className="badge warning">客先注番未入力</span>
              <span style={{ marginLeft: 8 }}>
                客先注番が空欄のため自動照合できなかった行が、べんりネット側{benrinetMissingKey.length.toLocaleString("ja-JP")}
                件・自社請求側{invoiceMissingKey.length.toLocaleString("ja-JP")}
                件あります。入力漏れの可能性があるため、下記の一覧で目視確認してください。
              </span>
              {invoiceMissingKey.length > 0 && (
                <div className="table-scroll table-scroll-v" style={{ marginTop: 10 }}>
                  <table>
                    <thead>
                      <tr>
                        <th>自社受注番号</th>
                        <th>品名</th>
                        <th className="num">数量</th>
                        <th className="num">金額</th>
                        <th>得意先名</th>
                        <th>件名</th>
                      </tr>
                    </thead>
                    <tbody>
                      {invoiceMissingKey.map((r, i) => (
                        <tr key={i}>
                          <td>{r.orderNo}</td>
                          <td className="truncate-cell">{r.itemName}</td>
                          <td className="num">{r.qty}</td>
                          <td className="num">{fmtYen(r.amount)}</td>
                          <td className="truncate-cell">{r.customerName}</td>
                          <td className="truncate-cell">{r.subject}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {benrinetMissingKey.length > 0 && (
                <div className="table-scroll table-scroll-v" style={{ marginTop: 10 }}>
                  <table>
                    <thead>
                      <tr>
                        <th>品名(べんりネット)</th>
                        <th className="num">数量</th>
                        <th className="num">金額</th>
                        <th>店舗</th>
                        <th>納品日</th>
                      </tr>
                    </thead>
                    <tbody>
                      {benrinetMissingKey.map((r, i) => (
                        <tr key={i}>
                          <td className="truncate-cell">{r.itemName}</td>
                          <td className="num">{r.qty}</td>
                          <td className="num">{fmtYen(r.amount)}</td>
                          <td className="truncate-cell">{r.storeName}</td>
                          <td>{fmtDate(r.deliveryDate)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          <div className="card">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
              <h2 style={{ margin: 0 }}>照合結果一覧</h2>
              <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                <div className="segmented">
                  <button className={statusFilter === "all" ? "active" : ""} onClick={() => setStatusFilter("all")}>
                    すべて({rows.length})
                  </button>
                  {STATUS_ORDER.map((s) => (
                    <button key={s} className={statusFilter === s ? "active" : ""} onClick={() => setStatusFilter(s)}>
                      {STATUS_LABEL[s]}({rows.filter((r) => r.status === s).length})
                    </button>
                  ))}
                </div>
                <input
                  type="text"
                  placeholder="客先注番・品名・得意先名などで検索"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  style={{ padding: "7px 9px", border: "1px solid var(--border)", borderRadius: 6, fontSize: 13, minWidth: 220 }}
                />
                <button className="ghost-btn" onClick={downloadCsv} disabled={!rows.length}>
                  結果をCSVでダウンロード
                </button>
              </div>
            </div>

            <div className="table-scroll table-scroll-v" style={{ marginTop: 14 }}>
              <table>
                <thead>
                  <tr>
                    <th>結果</th>
                    <th>客先注番/行</th>
                    <th>品名(べんりネット)</th>
                    <th className="num">数量/単価(べんりネット)</th>
                    <th className="num">金額(べんりネット)</th>
                    <th>品名(自社)</th>
                    <th className="num">数量/単価(自社)</th>
                    <th className="num">金額(自社)</th>
                    <th>得意先名/受注番号</th>
                    <th className="num">差額</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredRows.length === 0 && (
                    <tr>
                      <td colSpan={10} className="empty-state">
                        この条件に一致するデータはありません
                      </td>
                    </tr>
                  )}
                  {filteredRows.map((r) => (
                    <tr key={r.key}>
                      <td>
                        <span className={STATUS_BADGE_CLASS[r.status]}>{STATUS_LABEL[r.status]}</span>
                      </td>
                      <td>
                        {r.customerOrderNo}/{r.lineNo}
                      </td>
                      <td className="truncate-cell">{r.benrinet?.itemName ?? "―"}</td>
                      <td className="num">
                        {r.benrinet ? `${r.benrinet.qty} × ${fmtYen(r.benrinet.unitPrice)}` : "―"}
                      </td>
                      <td className="num">{r.benrinet ? fmtYen(r.benrinet.amount) : "―"}</td>
                      <td className="truncate-cell">{r.invoice?.itemName ?? "―"}</td>
                      <td className="num">{r.invoice ? `${r.invoice.qty} × ${fmtYen(r.invoice.unitPrice)}` : "―"}</td>
                      <td className="num">{r.invoice ? fmtYen(r.invoice.amount) : "―"}</td>
                      <td className="truncate-cell">
                        {r.invoice?.customerName ?? "―"}
                        {r.invoice?.orderNo ? <span className="cell-sub"> ({r.invoice.orderNo})</span> : null}
                      </td>
                      <td
                        className="num"
                        style={{
                          color: r.status === "amount_mismatch" ? "var(--critical)" : undefined,
                          fontWeight: r.status === "amount_mismatch" ? 600 : undefined,
                        }}
                      >
                        {r.benrinet && r.invoice ? fmtYen(r.diff) : "―"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
