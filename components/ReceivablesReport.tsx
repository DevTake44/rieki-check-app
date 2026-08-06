"use client";

import { useMemo, useState } from "react";
import Papa from "papaparse";
import { branchLabel } from "@/lib/branch-names";

/**
 * 売掛残高月報
 *
 * 目的: 拠点別の「売掛残高」CSV(得意先ごとの前月残高・当月売上・消費税・入金額・当月残高、
 * 末尾に合計行と税率別内訳行が付くもの)をドラッグ&ドロップで読み込み、
 * ①拠点ごとの集計、②その集計から作る簡易仕訳(借方:売掛金／貸方:商品売上・仮受消費税)
 * を自動で作成する。Supabaseには保存せず、この場で読み込むだけ(ブラウザ内完結)。
 *
 * ■ CSVの構造(実データで確認、2026-08-06):
 * 1行目: 営業所,拠点コード,拠点名(社内表記),,対象年月,YYYY年MM月
 * 2行目: 列見出し(カナ名称,請求先コード,名称,前月残高,(総売上額),(返品値引額),
 *        純売上額(税抜),消費税,(現金振込額),(手形額),(相殺値引額),(手数料他),入金額,当月残高)
 * 3行目以降: 得意先ごとの明細行(上記14列)
 * 「合計」行: 名称列が"合計"、他の得意先行と同じ14列に拠点全体の合計値が入る
 * 合計行の直後: 税率別の内訳行(名称列が"１０％"/"軽減税率"/"８％"など、
 *   総売上額・返品値引額・純売上額(税抜)・消費税の4列だけに値が入る)
 *
 * ■ 簡易仕訳の作り方(2026-08-06にユーザーと確認済み):
 * 借方: 売掛金 = 合計行の 純売上額(税抜) + 消費税
 * 貸方: 内訳行(10%・軽減税率・8%など)ごとに「商品売上(区分)」＝純売上額(税抜)、
 *       「仮受消費税(区分)」＝消費税 の2行ずつ(0円の区分は表示しない)
 * 借方合計と貸方合計は理論上一致する(振替伝票の実例で確認済み)。
 *
 * ■ 既知の限界:
 * このCSVには「非課税」区分が独立して存在せず、実際の振替伝票では非課税として
 * 計上されている売上も、CSV上は「10%」区分に合算されてしまっている
 * (実データで確認: 差額42,000円が非課税分)。そのため貸方の行内訳は実際の
 * 仕訳と完全には一致しないことがあるが、合計金額は一致する。
 */

type CustomerRow = {
  kana: string;
  customerCode: string;
  customerName: string;
  prevBalance: number;
  grossSales: number;
  returns: number;
  netSalesExTax: number;
  tax: number;
  cashReceived: number;
  bill: number;
  offset: number;
  fee: number;
  totalReceived: number;
  currentBalance: number;
};

type TaxBreakdownRow = {
  label: string;
  salesExTax: number;
  tax: number;
};

type BranchTotals = {
  prevBalance: number;
  grossSales: number;
  returns: number;
  netSalesExTax: number;
  tax: number;
  cashReceived: number;
  bill: number;
  offset: number;
  fee: number;
  totalReceived: number;
  currentBalance: number;
};

type BranchReport = {
  fileName: string;
  branchCode: string;
  branchNameRaw: string;
  period: string;
  customers: CustomerRow[];
  totals: BranchTotals;
  taxBreakdown: TaxBreakdownRow[];
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

function fmtYen(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "―";
  return `¥${Math.round(n).toLocaleString("ja-JP")}`;
}

function cell(cols: string[], i: number): string {
  const v = cols[i];
  return v === undefined || v === null ? "" : String(v).trim();
}

function num(cols: string[], i: number): number {
  const v = cell(cols, i).replace(/,/g, "");
  if (v === "") return 0;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function isBlankRow(cols: string[]): boolean {
  return cols.every((c) => (c ?? "").trim() === "");
}

function emptyTotals(): BranchTotals {
  return {
    prevBalance: 0,
    grossSales: 0,
    returns: 0,
    netSalesExTax: 0,
    tax: 0,
    cashReceived: 0,
    bill: 0,
    offset: 0,
    fee: 0,
    totalReceived: 0,
    currentBalance: 0,
  };
}

function totalsFromRow(r: string[]): BranchTotals {
  return {
    prevBalance: num(r, 3),
    grossSales: num(r, 4),
    returns: num(r, 5),
    netSalesExTax: num(r, 6),
    tax: num(r, 7),
    cashReceived: num(r, 8),
    bill: num(r, 9),
    offset: num(r, 10),
    fee: num(r, 11),
    totalReceived: num(r, 12),
    currentBalance: num(r, 13),
  };
}

function parseReceivablesCsv(rows: string[][], fileName: string): BranchReport | { error: string } {
  const dataRows = rows.filter((r) => !isBlankRow(r));
  if (dataRows.length < 3) {
    return { error: "行数が少なすぎます。売掛残高CSVの形式と異なる可能性があります。" };
  }

  const info = dataRows[0];
  if (cell(info, 0) !== "営業所") {
    return { error: "1行目が「営業所,拠点コード,...」の形式ではありません。売掛残高CSVを選択してください。" };
  }
  const branchCode = cell(info, 1);
  const branchNameRaw = cell(info, 2);
  const period = cell(info, 5);

  const customers: CustomerRow[] = [];
  let totals: BranchTotals | null = null;
  const taxBreakdown: TaxBreakdownRow[] = [];

  let i = 2; // 0行目=拠点情報、1行目=列見出し
  for (; i < dataRows.length; i++) {
    const r = dataRows[i];
    const name = cell(r, 2);
    if (name === "合計") {
      totals = totalsFromRow(r);
      i++;
      break;
    }
    customers.push({
      kana: cell(r, 0),
      customerCode: cell(r, 1),
      customerName: name,
      prevBalance: num(r, 3),
      grossSales: num(r, 4),
      returns: num(r, 5),
      netSalesExTax: num(r, 6),
      tax: num(r, 7),
      cashReceived: num(r, 8),
      bill: num(r, 9),
      offset: num(r, 10),
      fee: num(r, 11),
      totalReceived: num(r, 12),
      currentBalance: num(r, 13),
    });
  }

  if (!totals) {
    return { error: "「合計」行が見つかりませんでした。売掛残高CSVの形式と異なる可能性があります。" };
  }

  for (; i < dataRows.length; i++) {
    const r = dataRows[i];
    const label = cell(r, 2);
    if (!label) continue;
    taxBreakdown.push({ label, salesExTax: num(r, 6), tax: num(r, 7) });
  }

  return { fileName, branchCode, branchNameRaw, period, customers, totals, taxBreakdown };
}

function isError(v: BranchReport | { error: string }): v is { error: string } {
  return "error" in v;
}

type JournalLine = { label: string; amount: number };

function buildJournal(totals: BranchTotals, taxBreakdown: TaxBreakdownRow[]) {
  const debit: JournalLine = { label: "売掛金", amount: totals.netSalesExTax + totals.tax };
  const credit: JournalLine[] = [];
  for (const b of taxBreakdown) {
    if (b.salesExTax !== 0) credit.push({ label: `商品売上(${b.label})`, amount: b.salesExTax });
    if (b.tax !== 0) credit.push({ label: `仮受消費税(${b.label})`, amount: b.tax });
  }
  const creditTotal = credit.reduce((sum, c) => sum + c.amount, 0);
  return { debit, credit, creditTotal, diff: Math.round((debit.amount - creditTotal) * 100) / 100 };
}

export default function ReceivablesReport() {
  const [fileState, setFileState] = useState<FileState>(initialFileState());
  const [reports, setReports] = useState<BranchReport[]>([]);
  const [dragOver, setDragOver] = useState(false);

  async function handleFiles(files: FileList) {
    setFileState({ fileNames: [], loading: true, errors: [] });
    const parsed: BranchReport[] = [];
    const errors: string[] = [];
    const fileNames: string[] = [];

    for (const file of Array.from(files)) {
      fileNames.push(file.name);
      try {
        const { text } = await readFileSmart(file);
        const csvRows = Papa.parse<string[]>(text, { skipEmptyLines: true }).data;
        const result = parseReceivablesCsv(csvRows, file.name);
        if (isError(result)) {
          errors.push(`${file.name}: ${result.error}`);
        } else {
          parsed.push(result);
        }
      } catch (e) {
        errors.push(`${file.name}: 読み込みエラー: ${String(e)}`);
      }
    }

    setReports(parsed);
    setFileState({ fileNames, loading: false, errors });
  }

  const combined = useMemo(() => {
    if (reports.length <= 1) return null;
    const totals = emptyTotals();
    const breakdownMap = new Map<string, TaxBreakdownRow>();
    let customerCount = 0;
    for (const r of reports) {
      customerCount += r.customers.length;
      totals.prevBalance += r.totals.prevBalance;
      totals.grossSales += r.totals.grossSales;
      totals.returns += r.totals.returns;
      totals.netSalesExTax += r.totals.netSalesExTax;
      totals.tax += r.totals.tax;
      totals.cashReceived += r.totals.cashReceived;
      totals.bill += r.totals.bill;
      totals.offset += r.totals.offset;
      totals.fee += r.totals.fee;
      totals.totalReceived += r.totals.totalReceived;
      totals.currentBalance += r.totals.currentBalance;
      for (const b of r.taxBreakdown) {
        const prev = breakdownMap.get(b.label);
        breakdownMap.set(b.label, {
          label: b.label,
          salesExTax: (prev?.salesExTax ?? 0) + b.salesExTax,
          tax: (prev?.tax ?? 0) + b.tax,
        });
      }
    }
    return { totals, taxBreakdown: Array.from(breakdownMap.values()), customerCount, branchCount: reports.length };
  }, [reports]);

  function csvEscape(v: unknown): string {
    const s = v === null || v === undefined ? "" : String(v);
    if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  }

  function downloadCsv() {
    const header = [
      "拠点コード",
      "拠点名",
      "対象年月",
      "カナ名称",
      "請求先コード",
      "名称",
      "前月残高",
      "総売上額",
      "返品値引額",
      "純売上額(税抜)",
      "消費税",
      "現金振込額",
      "手形額",
      "相殺値引額",
      "手数料他",
      "入金額",
      "当月残高",
    ];
    const lines = [header.map(csvEscape).join(",")];
    for (const r of reports) {
      for (const c of r.customers) {
        lines.push(
          [
            r.branchCode,
            r.branchNameRaw,
            r.period,
            c.kana,
            c.customerCode,
            c.customerName,
            Math.round(c.prevBalance),
            Math.round(c.grossSales),
            Math.round(c.returns),
            Math.round(c.netSalesExTax),
            Math.round(c.tax),
            Math.round(c.cashReceived),
            Math.round(c.bill),
            Math.round(c.offset),
            Math.round(c.fee),
            Math.round(c.totalReceived),
            Math.round(c.currentBalance),
          ]
            .map(csvEscape)
            .join(",")
        );
      }
    }
    const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    a.download = `売掛残高月報_${today}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function renderTotalsTable(totals: BranchTotals) {
    return (
      <table>
        <tbody>
          <tr>
            <td>前月残高</td>
            <td style={{ textAlign: "right" }}>{fmtYen(totals.prevBalance)}</td>
          </tr>
          <tr>
            <td>総売上額</td>
            <td style={{ textAlign: "right" }}>{fmtYen(totals.grossSales)}</td>
          </tr>
          <tr>
            <td>返品値引額</td>
            <td style={{ textAlign: "right" }}>{fmtYen(totals.returns)}</td>
          </tr>
          <tr>
            <td>純売上額(税抜)</td>
            <td style={{ textAlign: "right" }}>{fmtYen(totals.netSalesExTax)}</td>
          </tr>
          <tr>
            <td>消費税</td>
            <td style={{ textAlign: "right" }}>{fmtYen(totals.tax)}</td>
          </tr>
          <tr>
            <td>入金額計(現金振込・手形・相殺値引・手数料他)</td>
            <td style={{ textAlign: "right" }}>{fmtYen(totals.totalReceived)}</td>
          </tr>
          <tr>
            <td>
              <strong>当月残高</strong>
            </td>
            <td style={{ textAlign: "right", fontWeight: "bold" }}>{fmtYen(totals.currentBalance)}</td>
          </tr>
        </tbody>
      </table>
    );
  }

  function renderJournal(totals: BranchTotals, taxBreakdown: TaxBreakdownRow[]) {
    const journal = buildJournal(totals, taxBreakdown);
    const balanced = Math.abs(journal.diff) < 1;
    return (
      <div>
        <table>
          <thead>
            <tr>
              <th>借方</th>
              <th style={{ textAlign: "right" }}>金額</th>
              <th>貸方</th>
              <th style={{ textAlign: "right" }}>金額</th>
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: Math.max(1, journal.credit.length) }).map((_, idx) => (
              <tr key={idx}>
                <td>{idx === 0 ? journal.debit.label : ""}</td>
                <td style={{ textAlign: "right" }}>{idx === 0 ? fmtYen(journal.debit.amount) : ""}</td>
                <td>{journal.credit[idx]?.label ?? ""}</td>
                <td style={{ textAlign: "right" }}>{journal.credit[idx] ? fmtYen(journal.credit[idx].amount) : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div style={{ marginTop: 8, fontSize: 13 }}>
          貸借差額:{" "}
          <span style={{ color: balanced ? "var(--good)" : "var(--critical)", fontWeight: "bold" }}>
            {fmtYen(journal.diff)}
          </span>{" "}
          {balanced ? <span className="badge good">バランス一致</span> : <span className="badge critical">不一致</span>}
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <h1>売掛残高月報</h1>
      <p className="subtitle">
        拠点別の売掛残高CSVをドラッグ&ドロップすると、拠点ごとの当月売上・消費税・入金額・当月残高の集計と、そこから作った簡易仕訳(借方:売掛金／貸方:商品売上・仮受消費税)を自動で表示します。複数拠点分をまとめてドロップすると、拠点ごとに加えて全社合計も表示します。CSVはこの場で読み込むだけでSupabaseには保存されません。
      </p>

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
        <h2 style={{ marginTop: 0 }}>売掛残高CSV</h2>
        <p className="subtitle" style={{ margin: "0 0 12px" }}>
          拠点(営業所)ごとに出力された売掛残高CSVを選択してください。複数拠点分をまとめてドロップできます。
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
            {dragOver ? "ここにドロップ" : "ここに売掛残高CSVをドラッグ&ドロップ、またはクリックして選択"}
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
            <div>読み込めた拠点数: {reports.length.toLocaleString("ja-JP")}件</div>
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

      {reports.length > 0 && (
        <>
          {combined && (
            <div className="card" style={{ marginBottom: 20, borderColor: "var(--direct)" }}>
              <h2 style={{ marginTop: 0 }}>
                全社合計({combined.branchCount}拠点・得意先{combined.customerCount.toLocaleString("ja-JP")}件)
              </h2>
              {renderTotalsTable(combined.totals)}
              <h3 style={{ marginBottom: 8 }}>簡易仕訳(合算)</h3>
              {renderJournal(combined.totals, combined.taxBreakdown)}
            </div>
          )}

          {reports.map((r, idx) => (
            <div className="card" key={idx} style={{ marginBottom: 20 }}>
              <h2 style={{ marginTop: 0 }}>
                {branchLabel(r.branchCode)} － {r.period}
                <span className="cell-sub" style={{ marginLeft: 10, fontWeight: "normal" }}>
                  ({r.branchNameRaw}・得意先{r.customers.length.toLocaleString("ja-JP")}件・{r.fileName})
                </span>
              </h2>
              {renderTotalsTable(r.totals)}
              <h3 style={{ marginBottom: 8 }}>簡易仕訳</h3>
              {renderJournal(r.totals, r.taxBreakdown)}
              <p className="cell-sub" style={{ marginTop: 8 }}>
                ※CSVの「10%」区分には非課税売上が合算されている場合があるため、実際の振替伝票の行内訳(非課税を独立科目で計上する場合など)とは一部異なることがあります。合計金額は一致します。
              </p>
            </div>
          ))}

          <div className="card">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
              <h2 style={{ margin: 0 }}>得意先別明細(全拠点)</h2>
              <button className="ghost-btn" onClick={downloadCsv}>
                この一覧をCSVでダウンロード
              </button>
            </div>
            <div className="table-scroll table-scroll-v">
              <table>
                <thead>
                  <tr>
                    <th>拠点</th>
                    <th>名称</th>
                    <th>請求先コード</th>
                    <th style={{ textAlign: "right" }}>前月残高</th>
                    <th style={{ textAlign: "right" }}>純売上額(税抜)</th>
                    <th style={{ textAlign: "right" }}>消費税</th>
                    <th style={{ textAlign: "right" }}>入金額</th>
                    <th style={{ textAlign: "right" }}>当月残高</th>
                  </tr>
                </thead>
                <tbody>
                  {reports.flatMap((r, ri) =>
                    r.customers.map((c, ci) => (
                      <tr key={`${ri}-${ci}`}>
                        <td>{branchLabel(r.branchCode)}</td>
                        <td>{c.customerName}</td>
                        <td>{c.customerCode}</td>
                        <td style={{ textAlign: "right" }}>{fmtYen(c.prevBalance)}</td>
                        <td style={{ textAlign: "right" }}>{fmtYen(c.netSalesExTax)}</td>
                        <td style={{ textAlign: "right" }}>{fmtYen(c.tax)}</td>
                        <td style={{ textAlign: "right" }}>{fmtYen(c.totalReceived)}</td>
                        <td style={{ textAlign: "right" }}>{fmtYen(c.currentBalance)}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      <div style={{ marginTop: 20 }}>
        <a
          href="/payable-check"
          className="ghost-btn"
          style={{ display: "inline-block", textDecoration: "none", marginRight: 10 }}
        >
          買掛月報照合
        </a>
        <a
          href="/freight-check"
          className="ghost-btn"
          style={{ display: "inline-block", textDecoration: "none", marginRight: 10 }}
        >
          運賃照合
        </a>
        <a href="/menu" className="ghost-btn" style={{ display: "inline-block", textDecoration: "none" }}>
          ← メニューに戻る
        </a>
      </div>
    </div>
  );
}
