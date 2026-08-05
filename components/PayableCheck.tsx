"use client";

import { useMemo, useState } from "react";
import Papa from "papaparse";

/**
 * 買掛月報照合ダッシュボード
 *
 * 「営業所別買掛残高」CSV(支払先ごと・営業所ごとの明細)と「買掛残高」CSV(支払先ごとの
 * 全社合計)の2つをこの画面にアップロードし、その場で(サーバーに送らず、ブラウザ内だけで)
 * 突き合わせて差異を表示する。データはどこにも保存しない(その場限りの照合)。
 *
 * ■ 照合の考え方
 * 「営業所別買掛残高」は支払先コードが営業所ごとに複数行に分かれているため、支払先コード
 * 単位で前月残高・総仕入額・支払額・当月残高を合計し、その合計値を「買掛残高」(全社合計、
 * 支払先コードにつき1行)の値と突き合わせる。
 * 例: 支払先コード208790は営業所別CSVでは「太幸大阪」と「太幸鳴尾在庫」の2行に分かれて
 * いるが、両方の総仕入額(185243+71717=256960)を足すと、買掛残高CSVの総仕入額(256960)と
 * 一致する。実際にサンプルデータで検証済み。
 *
 * ■ ヘッダー行の位置について
 * 「営業所別買掛残高」は1行目がそのままヘッダー行だが、「買掛残高」は1行目が
 * 「対象年月,2026年 6月」のようなタイトル行で、2行目が本当のヘッダー行になっている。
 * ファイルによってヘッダー行の位置がズレる可能性があるため、決め打ちで行番号を指定せず、
 * 「支払先コード」「前月残高」「総仕入額」「支払額」「当月残高」を全部含む行を探して
 * ヘッダー行として扱う(findHeaderRow)。
 *
 * ■ 末尾の合計行について
 * 「買掛残高」CSVの末尾には「合計」「10%」「軽減税率」「8%」など、支払先コードが空欄の
 * 集計行が付いている。支払先コードが空の行は除外して、明細行だけを対象にする。
 *
 * ■ 差異の判定基準
 * サンプルデータで検証したところ、消費税の端数処理の違いとみられるごく僅かな差(数円〜数十円
 * 程度)が一部の支払先に見られた(丸め誤差の可能性が高い)。これと、本当に確認が必要な大きな
 * 差異(実際にサンプルにあった例: 支払額が営業所別では計上済みなのに全社合計では0円のまま、
 * という約900万円の差)を区別するため、閾値を設けて「僅少差」と「金額相違」に分けて表示する。
 */

type BranchRecord = {
  code: string;
  name: string;
  branchCode: string;
  branchName: string;
  targetMonth: string;
  prev: number;
  purchase: number;
  pay: number;
  cur: number;
};

type TotalRecord = {
  code: string;
  name: string;
  prev: number;
  purchase: number;
  pay: number;
  cur: number;
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

function csvEscape(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toNum(s: string | undefined): number {
  if (!s) return 0;
  const n = parseFloat(s.trim().replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
}

/** 複数行スキャンして、必要な列名を全部含む行をヘッダー行として探す。 */
function findHeaderRow(rows: string[][], requiredCols: string[]): number {
  const scanLimit = Math.min(5, rows.length);
  for (let i = 0; i < scanLimit; i++) {
    const trimmed = rows[i].map((c) => c.trim());
    if (requiredCols.every((c) => trimmed.includes(c))) return i;
  }
  return -1;
}

function rowsToObjects(rows: string[][], headerIdx: number): Record<string, string>[] {
  const header = rows[headerIdx].map((c) => c.trim());
  return rows.slice(headerIdx + 1).map((row) => {
    const obj: Record<string, string> = {};
    header.forEach((h, i) => {
      if (h) obj[h] = row[i] ?? "";
    });
    return obj;
  });
}

/** "202606" 形式、または "2026年 6月" 形式のどちらでも受け取ってYYYYMMに揃える。 */
function normalizeTargetMonth(raw: string): string {
  const s = raw.trim();
  if (/^\d{6}$/.test(s)) return s;
  const m = s.match(/(\d{4})\s*年\s*(\d{1,2})\s*月/);
  if (m) return `${m[1]}${m[2].padStart(2, "0")}`;
  return "";
}

function parseBranchCsv(text: string): { records: BranchRecord[]; warnings: string[]; targetMonth: string } {
  const rows = Papa.parse<string[]>(text, { skipEmptyLines: true }).data;
  const required = ["支払先コード", "前月残高", "総仕入額", "支払額", "当月残高", "営業所コード"];
  const headerIdx = findHeaderRow(rows, required);
  if (headerIdx === -1) {
    return {
      records: [],
      warnings: ["必要な列(支払先コード・営業所コード・前月残高・総仕入額・支払額・当月残高)を含むヘッダー行が見つかりませんでした。営業所別買掛残高のCSVで間違いないか確認してください。"],
      targetMonth: "",
    };
  }
  const objs = rowsToObjects(rows, headerIdx).filter((r) => (r["支払先コード"] || "").trim() !== "");
  const records: BranchRecord[] = objs.map((r) => ({
    code: (r["支払先コード"] || "").trim(),
    name: (r["支払先名"] || "").trim(),
    branchCode: (r["営業所コード"] || "").trim(),
    branchName: (r["営業所名"] || "").trim(),
    targetMonth: normalizeTargetMonth(r["対象年月"] || ""),
    prev: toNum(r["前月残高"]),
    purchase: toNum(r["総仕入額"]),
    pay: toNum(r["支払額"]),
    cur: toNum(r["当月残高"]),
  }));
  const targetMonth = records.find((r) => r.targetMonth)?.targetMonth || "";
  const warnings: string[] = [];
  if (records.length === 0) warnings.push("読み込める形式のデータ行が1件もありませんでした。");
  return { records, warnings, targetMonth };
}

function parseTotalCsv(text: string): { records: TotalRecord[]; warnings: string[]; targetMonth: string } {
  const rows = Papa.parse<string[]>(text, { skipEmptyLines: true }).data;
  const required = ["支払先コード", "前月残高", "総仕入額", "支払額", "当月残高"];
  const headerIdx = findHeaderRow(rows, required);
  if (headerIdx === -1) {
    return {
      records: [],
      warnings: ["必要な列(支払先コード・前月残高・総仕入額・支払額・当月残高)を含むヘッダー行が見つかりませんでした。買掛残高(全社)のCSVで間違いないか確認してください。"],
      targetMonth: "",
    };
  }
  // タイトル行(「対象年月,2026年 6月」など、ヘッダー行より前にある行)から対象月を拾う。
  let targetMonth = "";
  for (let i = 0; i < headerIdx; i++) {
    for (const cell of rows[i]) {
      const norm = normalizeTargetMonth(cell);
      if (norm) targetMonth = norm;
    }
  }
  const objs = rowsToObjects(rows, headerIdx).filter((r) => (r["支払先コード"] || "").trim() !== "");
  const records: TotalRecord[] = objs.map((r) => ({
    code: (r["支払先コード"] || "").trim(),
    name: (r["名称"] || "").trim(),
    prev: toNum(r["前月残高"]),
    purchase: toNum(r["総仕入額"]),
    pay: toNum(r["支払額"]),
    cur: toNum(r["当月残高"]),
  }));
  const warnings: string[] = [];
  if (records.length === 0) warnings.push("読み込める形式のデータ行が1件もありませんでした。");
  return { records, warnings, targetMonth };
}

type FieldKey = "prev" | "purchase" | "pay" | "cur";
const FIELD_KEYS: FieldKey[] = ["prev", "purchase", "pay", "cur"];
const FIELD_LABEL: Record<FieldKey, string> = {
  prev: "前月残高",
  purchase: "総仕入額",
  pay: "支払額",
  cur: "当月残高",
};

// 消費税の端数処理の違いなど、実害の無い僅かな差とみられるものと、確認が必要な差を
// 分けるための閾値。サンプルデータでは丸め誤差とみられる差は最大でも数十円程度だった。
const MINOR_DIFF_THRESHOLD = 100;

type Status = "mismatch" | "minor_diff" | "match" | "branch_only" | "total_only";

type ReconcileRow = {
  code: string;
  name: string;
  status: Status;
  branch: { prev: number; purchase: number; pay: number; cur: number; branchCount: number } | null;
  total: TotalRecord | null;
  diffs: Record<FieldKey, number>;
  maxAbsDiff: number;
};

const STATUS_ORDER: Status[] = ["mismatch", "branch_only", "total_only", "minor_diff", "match"];
const STATUS_LABEL: Record<Status, string> = {
  mismatch: "金額相違",
  minor_diff: "僅少差(丸め誤差の可能性)",
  match: "一致",
  branch_only: "営業所別のみ",
  total_only: "買掛残高のみ",
};
const STATUS_BADGE_CLASS: Record<Status, string> = {
  mismatch: "badge critical",
  minor_diff: "badge neutral",
  match: "badge good",
  branch_only: "badge warning",
  total_only: "badge warning",
};

export default function PayableCheck() {
  const [branchState, setBranchState] = useState<FileState>(initialFileState());
  const [totalState, setTotalState] = useState<FileState>(initialFileState());
  const [branchRecords, setBranchRecords] = useState<BranchRecord[]>([]);
  const [totalRecords, setTotalRecords] = useState<TotalRecord[]>([]);
  const [branchWarnings, setBranchWarnings] = useState<string[]>([]);
  const [totalWarnings, setTotalWarnings] = useState<string[]>([]);
  const [branchTargetMonth, setBranchTargetMonth] = useState("");
  const [totalTargetMonth, setTotalTargetMonth] = useState("");
  const [statusFilter, setStatusFilter] = useState<Status | "all">("all");
  const [search, setSearch] = useState("");
  const [dragOverBranch, setDragOverBranch] = useState(false);
  const [dragOverTotal, setDragOverTotal] = useState(false);

  async function handleBranchFile(file: File) {
    setBranchState({ ...initialFileState(), fileName: file.name, loading: true });
    try {
      const { text, encoding } = await readFileSmart(file);
      const { records, warnings, targetMonth } = parseBranchCsv(text);
      setBranchRecords(records);
      setBranchWarnings(warnings);
      setBranchTargetMonth(targetMonth);
      setBranchState({
        fileName: file.name,
        encoding,
        loading: false,
        error: records.length === 0 ? warnings[0] || "読み込みに失敗しました。" : null,
      });
    } catch (e) {
      setBranchRecords([]);
      setBranchState({ fileName: file.name, encoding: "", loading: false, error: String(e) });
    }
  }

  async function handleTotalFile(file: File) {
    setTotalState({ ...initialFileState(), fileName: file.name, loading: true });
    try {
      const { text, encoding } = await readFileSmart(file);
      const { records, warnings, targetMonth } = parseTotalCsv(text);
      setTotalRecords(records);
      setTotalWarnings(warnings);
      setTotalTargetMonth(targetMonth);
      setTotalState({
        fileName: file.name,
        encoding,
        loading: false,
        error: records.length === 0 ? warnings[0] || "読み込みに失敗しました。" : null,
      });
    } catch (e) {
      setTotalRecords([]);
      setTotalState({ fileName: file.name, encoding: "", loading: false, error: String(e) });
    }
  }

  function reset() {
    setBranchState(initialFileState());
    setTotalState(initialFileState());
    setBranchRecords([]);
    setTotalRecords([]);
    setBranchWarnings([]);
    setTotalWarnings([]);
    setBranchTargetMonth("");
    setTotalTargetMonth("");
    setStatusFilter("all");
    setSearch("");
  }

  const { rows, summary } = useMemo(() => {
    const bMap = new Map<string, { prev: number; purchase: number; pay: number; cur: number; branchCount: number; name: string }>();
    branchRecords.forEach((r) => {
      const existing = bMap.get(r.code);
      if (existing) {
        existing.prev += r.prev;
        existing.purchase += r.purchase;
        existing.pay += r.pay;
        existing.cur += r.cur;
        existing.branchCount += 1;
      } else {
        bMap.set(r.code, { prev: r.prev, purchase: r.purchase, pay: r.pay, cur: r.cur, branchCount: 1, name: r.name });
      }
    });
    const tMap = new Map<string, TotalRecord>();
    totalRecords.forEach((r) => tMap.set(r.code, r));

    const keys = new Set<string>([...bMap.keys(), ...tMap.keys()]);
    const out: ReconcileRow[] = [];
    keys.forEach((code) => {
      const b = bMap.get(code) || null;
      const t = tMap.get(code) || null;
      const name = t?.name || b?.name || "";

      let status: Status;
      const diffs: Record<FieldKey, number> = { prev: 0, purchase: 0, pay: 0, cur: 0 };
      let maxAbsDiff = 0;

      if (b && t) {
        FIELD_KEYS.forEach((f) => {
          const d = b[f] - t[f];
          diffs[f] = d;
          maxAbsDiff = Math.max(maxAbsDiff, Math.abs(d));
        });
        if (maxAbsDiff >= MINOR_DIFF_THRESHOLD) status = "mismatch";
        else if (maxAbsDiff >= 1) status = "minor_diff";
        else status = "match";
      } else if (b) {
        status = "branch_only";
      } else {
        status = "total_only";
      }

      out.push({
        code,
        name,
        status,
        branch: b,
        total: t,
        diffs,
        maxAbsDiff,
      });
    });

    out.sort((a, b) => {
      const oa = STATUS_ORDER.indexOf(a.status);
      const ob = STATUS_ORDER.indexOf(b.status);
      if (oa !== ob) return oa - ob;
      if (a.status !== "match") {
        // 相違系は差額の大きい順
        if (b.maxAbsDiff !== a.maxAbsDiff) return b.maxAbsDiff - a.maxAbsDiff;
      }
      return a.code.localeCompare(b.code);
    });

    const branchTotal = { prev: 0, purchase: 0, pay: 0, cur: 0 };
    branchRecords.forEach((r) => {
      branchTotal.prev += r.prev;
      branchTotal.purchase += r.purchase;
      branchTotal.pay += r.pay;
      branchTotal.cur += r.cur;
    });
    const totalTotal = { prev: 0, purchase: 0, pay: 0, cur: 0 };
    totalRecords.forEach((r) => {
      totalTotal.prev += r.prev;
      totalTotal.purchase += r.purchase;
      totalTotal.pay += r.pay;
      totalTotal.cur += r.cur;
    });

    const summary = {
      total: out.length,
      match: out.filter((r) => r.status === "match").length,
      minorDiff: out.filter((r) => r.status === "minor_diff").length,
      mismatch: out.filter((r) => r.status === "mismatch").length,
      branchOnly: out.filter((r) => r.status === "branch_only").length,
      totalOnly: out.filter((r) => r.status === "total_only").length,
      branchTotal,
      totalTotal,
    };

    return { rows: out, summary };
  }, [branchRecords, totalRecords]);

  const filteredRows = useMemo(() => {
    let r = rows;
    if (statusFilter !== "all") r = r.filter((x) => x.status === statusFilter);
    if (search.trim()) {
      const s = search.trim().toLowerCase();
      r = r.filter((x) => `${x.code} ${x.name}`.toLowerCase().includes(s));
    }
    return r;
  }, [rows, statusFilter, search]);

  const monthMismatch =
    branchTargetMonth && totalTargetMonth && branchTargetMonth !== totalTargetMonth;

  function downloadCsv() {
    if (!rows.length) return;
    const headers = [
      "照合結果",
      "支払先コード",
      "支払先名",
      "営業所数",
      "前月残高_営業所合計",
      "前月残高_買掛残高",
      "前月残高_差額",
      "総仕入額_営業所合計",
      "総仕入額_買掛残高",
      "総仕入額_差額",
      "支払額_営業所合計",
      "支払額_買掛残高",
      "支払額_差額",
      "当月残高_営業所合計",
      "当月残高_買掛残高",
      "当月残高_差額",
    ];
    const lines = [headers.map(csvEscape).join(",")];
    rows.forEach((r) => {
      lines.push(
        [
          STATUS_LABEL[r.status],
          r.code,
          r.name,
          r.branch?.branchCount ?? "",
          r.branch?.prev ?? "",
          r.total?.prev ?? "",
          r.branch && r.total ? Math.round(r.diffs.prev) : "",
          r.branch?.purchase ?? "",
          r.total?.purchase ?? "",
          r.branch && r.total ? Math.round(r.diffs.purchase) : "",
          r.branch?.pay ?? "",
          r.total?.pay ?? "",
          r.branch && r.total ? Math.round(r.diffs.pay) : "",
          r.branch?.cur ?? "",
          r.total?.cur ?? "",
          r.branch && r.total ? Math.round(r.diffs.cur) : "",
        ]
          .map(csvEscape)
          .join(",")
      );
    });
    const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `買掛月報照合結果_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const bothLoaded = branchRecords.length > 0 && totalRecords.length > 0;

  function fieldCell(r: ReconcileRow, f: FieldKey) {
    if (!r.branch || !r.total) {
      const v = r.branch ? r.branch[f] : r.total ? r.total[f] : null;
      return <td className="num">{fmtYen(v)}</td>;
    }
    const d = r.diffs[f];
    const isDiff = Math.abs(d) >= 1;
    return (
      <td className="num">
        {fmtYen(r.total[f])}
        {isDiff && (
          <div
            className="cell-sub"
            style={{ color: Math.abs(d) >= MINOR_DIFF_THRESHOLD ? "var(--critical)" : "var(--warning)" }}
          >
            差{fmtYen(d)}(営業所合計{fmtYen(r.branch[f])})
          </div>
        )}
      </td>
    );
  }

  return (
    <div className="page">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 12 }}>
        <div>
          <h1>買掛月報照合</h1>
          <p className="subtitle">
            「営業所別買掛残高」と「買掛残高(全社)」の2つのCSVをこの画面にアップロードすると、その場で(サーバーに送信せず)支払先コード単位で前月残高・総仕入額・支払額・当月残高を突き合わせます。
          </p>
        </div>
        <div style={{ display: "flex", gap: 10, marginTop: 4 }}>
          <a href="/profit" className="ghost-btn" style={{ textDecoration: "none" }}>
            売上利益
          </a>
          <a href="/internal-transfer" className="ghost-btn" style={{ textDecoration: "none" }}>
            社内間金額
          </a>
          <a href="/benrinet-check" className="ghost-btn" style={{ textDecoration: "none" }}>
            べんりネット照合
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
        <div
          className="card"
          onDragOver={(e) => {
            e.preventDefault();
            setDragOverBranch(true);
          }}
          onDragLeave={() => setDragOverBranch(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOverBranch(false);
            const f = e.dataTransfer.files?.[0];
            if (f) handleBranchFile(f);
          }}
          style={dragOverBranch ? { outline: "2px dashed var(--direct)", outlineOffset: -2 } : undefined}
        >
          <h2 style={{ marginTop: 0, fontSize: 16 }}>① 営業所別買掛残高CSV</h2>
          <p className="cell-sub" style={{ margin: "0 0 8px" }}>
            ファイルをここにドラッグ&ドロップ、または下のボタンで選択してください。
          </p>
          <input
            type="file"
            accept=".csv"
            disabled={branchState.loading}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) handleBranchFile(f);
              e.target.value = "";
            }}
          />
          {branchState.fileName && (
            <div style={{ marginTop: 10, fontSize: 12.5 }}>
              <div>ファイル: {branchState.fileName}</div>
              {branchState.encoding && <div className="cell-sub">文字コード: {branchState.encoding}</div>}
              {branchTargetMonth && <div className="cell-sub">対象年月: {branchTargetMonth}</div>}
              {branchState.loading && <div style={{ color: "var(--direct)" }}>読み込み中…</div>}
              {!branchState.loading && branchRecords.length > 0 && (
                <div style={{ color: "var(--good)" }}>{branchRecords.length.toLocaleString("ja-JP")}件を読み込みました</div>
              )}
              {branchState.error && <div style={{ color: "var(--critical)" }}>{branchState.error}</div>}
              {branchWarnings.map((w, i) => (
                <div key={i} style={{ color: "var(--warning)" }}>
                  {w}
                </div>
              ))}
            </div>
          )}
        </div>
        <div
          className="card"
          onDragOver={(e) => {
            e.preventDefault();
            setDragOverTotal(true);
          }}
          onDragLeave={() => setDragOverTotal(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOverTotal(false);
            const f = e.dataTransfer.files?.[0];
            if (f) handleTotalFile(f);
          }}
          style={dragOverTotal ? { outline: "2px dashed var(--direct)", outlineOffset: -2 } : undefined}
        >
          <h2 style={{ marginTop: 0, fontSize: 16 }}>② 買掛残高CSV(全社合計)</h2>
          <p className="cell-sub" style={{ margin: "0 0 8px" }}>
            ファイルをここにドラッグ&ドロップ、または下のボタンで選択してください。
          </p>
          <input
            type="file"
            accept=".csv"
            disabled={totalState.loading}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) handleTotalFile(f);
              e.target.value = "";
            }}
          />
          {totalState.fileName && (
            <div style={{ marginTop: 10, fontSize: 12.5 }}>
              <div>ファイル: {totalState.fileName}</div>
              {totalState.encoding && <div className="cell-sub">文字コード: {totalState.encoding}</div>}
              {totalTargetMonth && <div className="cell-sub">対象年月: {totalTargetMonth}</div>}
              {totalState.loading && <div style={{ color: "var(--direct)" }}>読み込み中…</div>}
              {!totalState.loading && totalRecords.length > 0 && (
                <div style={{ color: "var(--good)" }}>{totalRecords.length.toLocaleString("ja-JP")}件を読み込みました</div>
              )}
              {totalState.error && <div style={{ color: "var(--critical)" }}>{totalState.error}</div>}
              {totalWarnings.map((w, i) => (
                <div key={i} style={{ color: "var(--warning)" }}>
                  {w}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {(branchRecords.length > 0 || totalRecords.length > 0) && (
        <div className="filter-actions" style={{ marginTop: -8, marginBottom: 20 }}>
          <button className="ghost-btn" onClick={reset}>
            リセット
          </button>
        </div>
      )}

      {monthMismatch && (
        <div className="card" style={{ marginBottom: 20, padding: "12px 16px", background: "rgba(192,57,43,0.06)" }}>
          <span className="badge critical">対象月が違います</span>
          <span style={{ marginLeft: 8 }}>
            営業所別買掛残高は{branchTargetMonth}、買掛残高(全社)は{totalTargetMonth}
            になっています。違う月同士を突き合わせると正しい結果になりません。同じ月のファイルか確認してください。
          </span>
        </div>
      )}

      {bothLoaded && (
        <>
          <div className="kpi-row">
            <div className="kpi-tile">
              <div className="label">前月残高(買掛残高)</div>
              <div className="value">{fmtYen(summary.totalTotal.prev)}</div>
            </div>
            <div className="kpi-tile">
              <div className="label">総仕入額(買掛残高)</div>
              <div className="value">{fmtYen(summary.totalTotal.purchase)}</div>
            </div>
            <div className="kpi-tile">
              <div className="label">支払額(買掛残高)</div>
              <div className="value">{fmtYen(summary.totalTotal.pay)}</div>
            </div>
            <div className="kpi-tile">
              <div className="label">当月残高(買掛残高)</div>
              <div className="value">{fmtYen(summary.totalTotal.cur)}</div>
            </div>
          </div>
          <p className="cell-sub" style={{ margin: "6px 0 0" }}>
            営業所別買掛残高の合計: 前月残高{fmtYen(summary.branchTotal.prev)} / 総仕入額
            {fmtYen(summary.branchTotal.purchase)} / 支払額{fmtYen(summary.branchTotal.pay)} / 当月残高
            {fmtYen(summary.branchTotal.cur)}
          </p>

          <div className="kpi-row" style={{ marginTop: 12 }}>
            <div className="kpi-tile" style={{ cursor: "pointer" }} onClick={() => setStatusFilter("all")}>
              <div className="label">支払先数(合計)</div>
              <div className="value">{summary.total.toLocaleString("ja-JP")}</div>
            </div>
            <div className="kpi-tile" style={{ cursor: "pointer" }} onClick={() => setStatusFilter("mismatch")}>
              <div className="label">金額相違</div>
              <div className="value" style={{ color: summary.mismatch > 0 ? "var(--critical)" : undefined }}>
                {summary.mismatch.toLocaleString("ja-JP")}
              </div>
            </div>
            <div className="kpi-tile" style={{ cursor: "pointer" }} onClick={() => setStatusFilter("branch_only")}>
              <div className="label">営業所別のみ</div>
              <div className="value" style={{ color: summary.branchOnly > 0 ? "var(--warning)" : undefined }}>
                {summary.branchOnly.toLocaleString("ja-JP")}
              </div>
            </div>
            <div className="kpi-tile" style={{ cursor: "pointer" }} onClick={() => setStatusFilter("total_only")}>
              <div className="label">買掛残高のみ</div>
              <div className="value" style={{ color: summary.totalOnly > 0 ? "var(--warning)" : undefined }}>
                {summary.totalOnly.toLocaleString("ja-JP")}
              </div>
            </div>
          </div>

          {summary.mismatch > 0 && (
            <div className="card" style={{ marginTop: 20, marginBottom: 20, padding: "12px 16px", background: "rgba(192,57,43,0.06)" }}>
              <span className="badge critical">要確認</span>
              <span style={{ marginLeft: 8 }}>
                前月残高・総仕入額・支払額・当月残高のいずれかが¥{MINOR_DIFF_THRESHOLD.toLocaleString("ja-JP")}
                以上違う支払先が{summary.mismatch.toLocaleString("ja-JP")}件あります。下の一覧で確認してください。
              </span>
            </div>
          )}

          <div className="card" style={{ marginTop: summary.mismatch > 0 ? 0 : 20 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
              <h2 style={{ margin: 0 }}>照合結果一覧(支払先単位)</h2>
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
                  placeholder="支払先コード・支払先名で検索"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  style={{ padding: "7px 9px", border: "1px solid var(--border)", borderRadius: 6, fontSize: 13, minWidth: 200 }}
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
                    <th>支払先コード/名</th>
                    <th className="num">営業所数</th>
                    <th className="num">前月残高</th>
                    <th className="num">総仕入額</th>
                    <th className="num">支払額</th>
                    <th className="num">当月残高</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredRows.length === 0 && (
                    <tr>
                      <td colSpan={7} className="empty-state">
                        この条件に一致するデータはありません
                      </td>
                    </tr>
                  )}
                  {filteredRows.map((r) => (
                    <tr key={r.code}>
                      <td>
                        <span className={STATUS_BADGE_CLASS[r.status]}>{STATUS_LABEL[r.status]}</span>
                      </td>
                      <td className="truncate-cell">
                        {r.code} {r.name}
                      </td>
                      <td className="num">{r.branch?.branchCount ?? "―"}</td>
                      {fieldCell(r, "prev")}
                      {fieldCell(r, "purchase")}
                      {fieldCell(r, "pay")}
                      {fieldCell(r, "cur")}
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
