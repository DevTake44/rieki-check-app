"use client";

import { useMemo, useState } from "react";
import Papa from "papaparse";
import type { ShippingNoteMappingRow, FreightSalesLine } from "@/lib/types";

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
 * ■ 2社のファイル形式の違い
 * 西濃運輸: 月,日,原票No.,元着,区分,着地名/発地名,数量,重量,合計(運賃),
 *   内燃料サーチャージ,備考1,備考2,お客さま番号。年が無いため日付は月/日のみの表示。
 *   「原票No.」が"999"始まりの行は、特定の送り状に紐づかない燃料サーチャージの
 *   アカウント単位集計行(着地名が空)で、送り状番号としてはヒットしない
 *   (=自動的に「対応する受注が見つからない」扱いになる。これは仕様として正しい)。
 * 福山通運: 得意先コード,部課所コード,締め日,請求書番号,発送年月日,原票番号,特殊コード,
 *   元着区分,個数,才数,重量,運賃,中継料,保険料,諸料金,諸料金区分,住所漢字区分,荷受人住所,
 *   名称漢字区分,荷受人名称,荷受人コード,お客様出荷番号,ＪＩＳコード,輸送距離,備考,
 *   サーチャージ料。実費は「運賃+中継料+保険料+諸料金+サーチャージ料」の合計とする
 *   (運賃だけでなく実際に支払う金額全体で比較するため)。発送年月日はYYMMDD(西暦下2桁)。
 *
 * ファイル形式は、ヘッダー行に「原票No」を含むか「原票番号」を含むかで自動判別する。
 */

type Carrier = "西濃運輸" | "福山通運";

type InvoiceLine = {
  carrier: Carrier;
  waybillNo: string;
  dateLabel: string;
  amount: number;
  destinationName: string;
  note: string;
  sourceFile: string;
};

type MatchStatus = "matched" | "no_mapping" | "no_freight_line";

type ResultRow = {
  key: string;
  carrier: Carrier;
  waybillNo: string;
  dateLabel: string;
  destinationName: string;
  orderNo: string | null;
  customerName: string | null;
  branchCode: string | null;
  repCode: string | null;
  deliveryNoteNo: string | null;
  actualFreight: number;
  chargedFreight: number | null;
  assumedCost: number | null;
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
    const destinationName = cell(cols, 5);
    const note = [cell(cols, 10), cell(cols, 11)].filter(Boolean).join(" ");
    out.push({
      carrier: "西濃運輸",
      waybillNo,
      dateLabel: month && day ? `${month}/${day}` : "",
      amount,
      destinationName,
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
    const destinationName = cell(cols, 19);
    const note = cell(cols, 24);
    out.push({
      carrier: "福山通運",
      waybillNo,
      dateLabel,
      amount,
      destinationName,
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

  const freightByOrder = useMemo(() => {
    const m = new Map<
      string,
      {
        sellPrice: number;
        assumedCost: number;
        branchCode: string | null;
        repCode: string | null;
        deliveryNoteNo: string | null;
        customerName: string | null;
      }
    >();
    for (const l of freightSalesLines) {
      if (!l.order_no) continue;
      const prev = m.get(l.order_no);
      const sellPrice = (prev?.sellPrice ?? 0) + (l.sell_price ?? 0);
      const assumedCost = (prev?.assumedCost ?? 0) + (l.assumed_cost ?? 0);
      m.set(l.order_no, {
        sellPrice,
        assumedCost,
        branchCode: prev?.branchCode ?? l.branch_code,
        repCode: prev?.repCode ?? l.rep_code,
        deliveryNoteNo: prev?.deliveryNoteNo ?? l.delivery_note_no,
        customerName: prev?.customerName ?? l.customer_name,
      });
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
            `${file.name}: ファイル形式を判別できませんでした(西濃運輸・福山通運のどちらの請求データ形式にも一致しません)。`
          );
          continue;
        }
        const dataRows = rows.slice(1);
        const lines = carrier === "西濃運輸" ? parseSeinoRows(dataRows, file.name) : parseFukuyamaRows(dataRows, file.name);
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
      const mapRow = mappingByWaybill.get(line.waybillNo);
      const orderNo = mapRow?.order_no ?? null;
      let status: MatchStatus;
      let chargedFreight: number | null = null;
      let assumedCost: number | null = null;
      let customerName: string | null = mapRow?.customer_name ?? null;
      let branchCode: string | null = null;
      let repCode: string | null = null;
      let deliveryNoteNo: string | null = null;
      let margin: number | null = null;

      if (!orderNo) {
        status = "no_mapping";
      } else {
        const freight = freightByOrder.get(orderNo);
        if (!freight) {
          status = "no_freight_line";
        } else {
          status = "matched";
          chargedFreight = freight.sellPrice;
          assumedCost = freight.assumedCost;
          branchCode = freight.branchCode;
          repCode = freight.repCode;
          deliveryNoteNo = freight.deliveryNoteNo;
          customerName = freight.customerName ?? customerName;
          margin = chargedFreight - line.amount;
        }
      }

      return {
        key: `${line.carrier}-${line.waybillNo}-${i}`,
        carrier: line.carrier,
        waybillNo: line.waybillNo,
        dateLabel: line.dateLabel,
        destinationName: line.destinationName,
        orderNo,
        customerName,
        branchCode,
        repCode,
        deliveryNoteNo,
        actualFreight: line.amount,
        chargedFreight,
        assumedCost,
        margin,
        status,
      };
    });
  }, [invoiceLines, mappingByWaybill, freightByOrder]);

  const summary = useMemo(() => {
    let totalActual = 0;
    let totalCharged = 0;
    let totalMargin = 0;
    let nMatched = 0;
    let nNoMapping = 0;
    let nNoFreightLine = 0;
    let lossCount = 0;
    for (const r of results) {
      totalActual += r.actualFreight;
      if (r.status === "matched") {
        nMatched++;
        totalCharged += r.chargedFreight ?? 0;
        totalMargin += r.margin ?? 0;
        if ((r.margin ?? 0) < 0) lossCount++;
      } else if (r.status === "no_mapping") {
        nNoMapping++;
      } else {
        nNoFreightLine++;
      }
    }
    return { totalActual, totalCharged, totalMargin, nMatched, nNoMapping, nNoFreightLine, lossCount, total: results.length };
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
      "拠点番号",
      "営業担当",
      "売上番号(納品書番号)",
      "実費運賃",
      "得意先への請求運賃",
      "見込み原価",
      "利益(請求-実費)",
      "状態",
    ];
    const statusLabel: Record<MatchStatus, string> = {
      matched: "照合済み",
      no_mapping: "対応する受注が見つからない",
      no_freight_line: "得意先への運賃請求なし",
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
          r.branchCode ?? "",
          r.repCode ?? "",
          r.deliveryNoteNo ?? "",
          Math.round(r.actualFreight),
          r.chargedFreight !== null ? Math.round(r.chargedFreight) : "",
          r.assumedCost !== null ? Math.round(r.assumedCost) : "",
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
        西濃運輸・福山通運の請求データ(実費運賃)を、事前に取り込んだ送り状番号↔受注番号の対応表(shipping_note_mapping)経由で自社の受注に変換し、得意先への運賃請求額(sales_linesの商品コード「99」運賃行)と突き合わせて、運賃で利益が取れているかを一覧にします。請求データはこの場で読み込むだけでSupabaseには保存されません。
      </p>

      <div className="card" style={{ marginBottom: 20 }}>
        <h2 style={{ marginTop: 0 }}>① 送り状番号↔受注番号の対応データ</h2>
        <p className="subtitle" style={{ margin: "0 0 8px" }}>
          「送り状問合せ」CSVから取り込み済みのデータです。取り込み・更新は
          <a href="/upload" style={{ marginLeft: 4 }}>
            データ更新
          </a>
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
          西濃運輸・福山通運どちらの請求CSVもドラッグ&ドロップまたは選択できます(ヘッダー行から自動判別)。複数ファイルをまとめて選択可能です。
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
            <div className="kpi-tile" style={{ cursor: "pointer" }} onClick={() => setStatusFilter("no_freight_line")}>
              <div className="label">得意先へ運賃請求なし</div>
              <div className="value">{summary.nNoFreightLine.toLocaleString("ja-JP")}</div>
            </div>
            <div className="kpi-tile" style={{ cursor: "pointer" }} onClick={() => setStatusFilter("no_mapping")}>
              <div className="label">対応する受注が見つからない</div>
              <div className="value">{summary.nNoMapping.toLocaleString("ja-JP")}</div>
            </div>
          </div>

          <div className="card" style={{ marginBottom: 20 }}>
            <h2 style={{ marginTop: 0 }}>金額サマリー(照合済み分)</h2>
            <table>
              <tbody>
                <tr>
                  <td>実費運賃合計(運送会社への支払額、請求データ全行)</td>
                  <td style={{ textAlign: "right" }}>{fmtYen(summary.totalActual)}</td>
                </tr>
                <tr>
                  <td>得意先への請求運賃合計(照合済み分のみ)</td>
                  <td style={{ textAlign: "right" }}>{fmtYen(summary.totalCharged)}</td>
                </tr>
                <tr>
                  <td>
                    <strong>運賃利益合計(請求 − 実費、照合済み分のみ)</strong>
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
                        {r.status === "no_freight_line" && <span className="badge warning">得意先へ運賃請求なし</span>}
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
        <a
          href="/benrinet-check"
          className="ghost-btn"
          style={{ display: "inline-block", textDecoration: "none", marginRight: 10 }}
        >
          べんりネット照合
        </a>
        <a
          href="/payable-check"
          className="ghost-btn"
          style={{ display: "inline-block", textDecoration: "none", marginRight: 10 }}
        >
          買掛月報照合
        </a>
        <a
          href="/life-check"
          className="ghost-btn"
          style={{ display: "inline-block", textDecoration: "none", marginRight: 10 }}
        >
          ライフ照合
        </a>
        <a
          href="/life-billing-check"
          className="ghost-btn"
          style={{ display: "inline-block", textDecoration: "none", marginRight: 10 }}
        >
          ライフ請求金額照合
        </a>
        <a href="/menu" className="ghost-btn" style={{ display: "inline-block", textDecoration: "none" }}>
          ← メニューに戻る
        </a>
      </div>
    </div>
  );
}
