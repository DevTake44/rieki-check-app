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
 * ■ 得意先の税率内訳行(2026-08-06にユーザーと確認・検証済み):
 * ある得意先の売上が複数の税率にまたがる場合、その得意先の名称行のすぐ下に、
 * 請求先コード・カナ名称が空欄で名称だけ税率区分名("１０％"・"軽減税率"など)の
 * 行が1つ以上続く。これは独立した別の得意先ではなく、直前の得意先の内訳
 * (人が見れば2行以上に分解された表示だと分かる)で、内訳行の純売上額(税抜)・
 * 消費税を合計すると、必ず得意先の名称行(本行)の値と一致する
 * (実データで確認: 例えば板橋貿易㈱は 本行(13,000円/1,060円) = "１０％"内訳行
 * (1,000円/100円) + "軽減税率"内訳行(12,000円/960円))。
 *
 * ■ 非課税の抜き出し(2026-08-06にユーザーと確認・検証済み):
 * このCSVには「非課税」区分が独立して存在せず、非課税の売上は「10%」の
 * 純売上額(税抜)に合算されてしまっている。ただし、非課税の対象になるのは
 * 「10%」として扱われる金額(内訳行が無い得意先の本行、または内訳行がある
 * 得意先の"１０％"内訳行)なので、それぞれの消費税額から「消費税÷10%」で
 * 課税対象額を逆算し、純売上額(税抜)との差を取ると、非課税を含む得意先(の
 * 10%部分)だけがまとまった金額(実データ例: 42,000円)として現れる
 * (それ以外は伝票の端数丸めによる数百円未満の誤差しか出ない)。
 * この差がNON_TAXABLE_NOISE_THRESHOLD円以上のものを「非課税を含む」とみなし、
 * その差額を合計して「10%」区分から切り出し、「商品売上(非課税・推定)」という
 * 独立した貸方行として表示する(実データで振替伝票の実例と完全一致を確認済み)。
 */

// 得意先ごとの「消費税÷10%で逆算した課税対象額」と「純売上額(税抜)」の差が
// この金額(円)以上なら、端数の丸め誤差ではなく非課税売上が含まれていると判断する。
// 実データでは、非課税を含まない得意先の差は最大でも数百円(端数丸め)、
// 非課税を含む得意先は数万円単位のまとまった金額で現れたため、
// 十分な余裕を持ってこの値をしきい値とした。
const NON_TAXABLE_NOISE_THRESHOLD = 1000;

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
  // 直下に税率別の内訳行(名称が"１０％"・"軽減税率"などでコード欄が空欄の行)が
  // 続いていた場合、その内容をここに保持する。合計すると必ず本行の値と一致する。
  // 空配列なら内訳行なし(この得意先の売上は単一の税率のみ)。
  subRows: TaxBreakdownRow[];
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

type NonTaxableCandidate = { customerCode: string; customerName: string; amount: number };

type BranchReport = {
  fileName: string;
  branchCode: string;
  branchNameRaw: string;
  period: string;
  customers: CustomerRow[];
  totals: BranchTotals;
  taxBreakdown: TaxBreakdownRow[];
  nonTaxableTotal: number;
  nonTaxableCandidates: NonTaxableCandidate[];
  multiRateCustomerCount: number;
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

    const c: CustomerRow = {
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
      subRows: [],
    };

    // 直後に続く、請求先コード・カナ名称が空欄の行は、この得意先の税率別
    // 内訳行(独立した得意先ではない)として吸収する。合計すると必ず本行と
    // 一致する(実データで確認済み)。
    for (let j = i + 1; j < dataRows.length; j++) {
      const sub = dataRows[j];
      const subName = cell(sub, 2);
      if (subName === "合計") break;
      if (cell(sub, 0) !== "" || cell(sub, 1) !== "" || !subName) break;
      c.subRows.push({ label: subName, salesExTax: num(sub, 6), tax: num(sub, 7) });
      i = j;
    }

    customers.push(c);
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

  // 「消費税÷10%」で課税対象額を逆算し、純売上額(税抜)との差を非課税売上の
  // 候補として拾う。内訳行がある得意先は、内訳行のうち"10%"区分のものだけを
  // 対象にする(本行はブレンドされた合計なので対象にしない)。
  const nonTaxableCandidates: NonTaxableCandidate[] = [];
  let multiRateCustomerCount = 0;
  for (const c of customers) {
    if (c.subRows.length > 0) {
      multiRateCustomerCount++;
      for (const s of c.subRows) {
        if (!isStandardRateLabel(s.label)) continue;
        if (s.salesExTax === 0) continue;
        const implied = Math.round(s.tax / 0.1);
        const gap = Math.round((s.salesExTax - implied) * 100) / 100;
        if (Math.abs(gap) >= NON_TAXABLE_NOISE_THRESHOLD) {
          nonTaxableCandidates.push({
            customerCode: c.customerCode,
            customerName: `${c.customerName}(内訳:${s.label})`,
            amount: gap,
          });
        }
      }
      continue;
    }
    if (c.netSalesExTax === 0) continue;
    const impliedTaxable10 = Math.round(c.tax / 0.1);
    const gap = Math.round((c.netSalesExTax - impliedTaxable10) * 100) / 100;
    if (Math.abs(gap) >= NON_TAXABLE_NOISE_THRESHOLD) {
      nonTaxableCandidates.push({ customerCode: c.customerCode, customerName: c.customerName, amount: gap });
    }
  }
  const nonTaxableTotal = nonTaxableCandidates.reduce((sum, c) => sum + c.amount, 0);

  return {
    fileName,
    branchCode,
    branchNameRaw,
    period,
    customers,
    totals,
    taxBreakdown,
    nonTaxableTotal,
    nonTaxableCandidates,
    multiRateCustomerCount,
  };
}

function isError(v: BranchReport | { error: string }): v is { error: string } {
  return "error" in v;
}

type JournalLine = { label: string; amount: number };

// 内訳行の名称が「標準10%」区分かどうかを判定する(全角/半角の"10"を許容)。
// 非課税の推定額はこの区分の純売上額(税抜)から切り出す。
function isStandardRateLabel(label: string): boolean {
  return label.includes("10") || label.includes("１０");
}

function buildJournal(totals: BranchTotals, taxBreakdown: TaxBreakdownRow[], nonTaxableTotal: number) {
  const debit: JournalLine = { label: "売掛金", amount: totals.netSalesExTax + totals.tax };
  const credit: JournalLine[] = [];
  for (const b of taxBreakdown) {
    if (isStandardRateLabel(b.label)) {
      const adjustedSales = Math.round((b.salesExTax - nonTaxableTotal) * 100) / 100;
      if (adjustedSales !== 0) credit.push({ label: `商品売上(${b.label})`, amount: adjustedSales });
      if (b.tax !== 0) credit.push({ label: `仮受消費税(${b.label})`, amount: b.tax });
      if (nonTaxableTotal !== 0) credit.push({ label: "商品売上(非課税・推定)", amount: nonTaxableTotal });
    } else {
      if (b.salesExTax !== 0) credit.push({ label: `商品売上(${b.label})`, amount: b.salesExTax });
      if (b.tax !== 0) credit.push({ label: `仮受消費税(${b.label})`, amount: b.tax });
    }
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
    let nonTaxableTotal = 0;
    let multiRateCustomerCount = 0;
    const nonTaxableCandidates: NonTaxableCandidate[] = [];
    for (const r of reports) {
      customerCount += r.customers.length;
      multiRateCustomerCount += r.multiRateCustomerCount;
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
      nonTaxableTotal += r.nonTaxableTotal;
      nonTaxableCandidates.push(...r.nonTaxableCandidates);
      for (const b of r.taxBreakdown) {
        const prev = breakdownMap.get(b.label);
        breakdownMap.set(b.label, {
          label: b.label,
          salesExTax: (prev?.salesExTax ?? 0) + b.salesExTax,
          tax: (prev?.tax ?? 0) + b.tax,
        });
      }
    }
    return {
      totals,
      taxBreakdown: Array.from(breakdownMap.values()),
      customerCount,
      branchCount: reports.length,
      nonTaxableTotal,
      nonTaxableCandidates,
      multiRateCustomerCount,
    };
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

  function renderJournal(
    totals: BranchTotals,
    taxBreakdown: TaxBreakdownRow[],
    nonTaxableTotal: number,
    nonTaxableCandidates: NonTaxableCandidate[],
    multiRateCustomerCount?: number
  ) {
    const journal = buildJournal(totals, taxBreakdown, nonTaxableTotal);
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
        {nonTaxableCandidates.length > 0 && (
          <div style={{ marginTop: 8, fontSize: 13 }}>
            非課税と推定した得意先({nonTaxableCandidates.length}件・合計{fmtYen(nonTaxableTotal)}):
            <ul style={{ margin: "4px 0 0", paddingLeft: 20 }}>
              {nonTaxableCandidates.map((c, i) => (
                <li key={i}>
                  {c.customerName}({c.customerCode}) {fmtYen(c.amount)}
                </li>
              ))}
            </ul>
          </div>
        )}
        {!!multiRateCustomerCount && (
          <div style={{ marginTop: 4, fontSize: 12 }} className="cell-sub">
            ※税率の内訳行が付いていた得意先{multiRateCustomerCount}件は、本行(合算値)ではなく内訳行の「10%」部分だけを非課税判定の対象にしています。
          </div>
        )}
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
              {renderJournal(
                combined.totals,
                combined.taxBreakdown,
                combined.nonTaxableTotal,
                combined.nonTaxableCandidates,
                combined.multiRateCustomerCount
              )}
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
              {renderJournal(r.totals, r.taxBreakdown, r.nonTaxableTotal, r.nonTaxableCandidates, r.multiRateCustomerCount)}
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
