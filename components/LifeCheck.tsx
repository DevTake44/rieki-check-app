"use client";

import { useMemo, useState } from "react";
import Papa from "papaparse";

/**
 * ライフ照合(受注番号さがし)ダッシュボード
 *
 * ライフコーポレーションの受領実績CSV(output.csv)の各明細行が、太幸のどの受注番号に
 * 対応するかを探す画面。厳密な一致・不一致を判定する「照合」ではなく、正しい受注番号を
 * 見つけるための「検索アシスタント」。データはどこにも保存しない(その場限り)。
 *
 * ■ 2段構えの候補探し
 * 1. 客先注番の完全一致(最優先・高精度): ライフ側CSVの「他伝票No」列の値が、
 *    太幸側CSV(受注出力)の「客先注番」列の値と完全に一致することを実データで確認済み
 *    (サンプル26行すべてで一致)。ただし太幸側は客先注番が空欄の受注が多い
 *    (電話注文など)ため、これだけには頼れない。
 * 2. 日付+店舗名(フォールバック・要目視確認): 客先注番が一致しない/空欄の場合、
 *    ライフの「納品指定日」と太幸の「納品年月日」が同じで、かつ店舗が一致する受注を
 *    候補として挙げる。単価はライフ側で更新されていないことがあるため照合に使わない。
 *    品名と数量を並べて表示し、目視で確認できるようにする。
 *
 * ■ 店舗の突き合わせ方
 * ライフの「店コード」(例:612)が、太幸の「納入先名１」に全角数字で埋め込まれている
 * ケースを確認した(例:「ライフ６１２東五反田店」「ライフ京急蒲田駅前店　６２２」)。
 * 全角→半角に変換したうえで、店コードが含まれるかで判定する。店コードで見つからない
 * 場合の保険として、「ライフ」や空白・数字を除いた店名同士の部分一致も試す。
 *
 * ■ 品名の突き合わせ方
 * 双方で商品コード・呼び方が異なるため完全一致は期待できない。文字bi-gram
 * (2文字ずつの組)のJaccard類似度で「似ている品名」を推定し、候補受注の中から
 * 一番近い品目を自動的に選んで並べて表示する(色分けで数量が合っているかも示す)。
 * あくまで目視確認の補助であり、この類似度だけで自動的に正解と断定はしない。
 */

type LifeLine = {
  key: string;
  slipNo: string;
  lineNo: string;
  deliveryDate: string;
  storeCode: string;
  storeName: string;
  itemName: string;
  qty: number;
  price: number;
  amount: number;
  otherSlipNo: string;
};

type TaikoItem = {
  itemName: string;
  qty: number;
  price: number;
  amount: number;
  deliverySlipNo: string;
  deliveryQty: number;
  transactionType: string;
};

type TaikoOrder = {
  orderNo: string;
  customerOrderNo: string;
  customerContact: string;
  customerCode: string;
  deliveryName: string;
  deliveryDate: string;
  subject: string;
  rep: string;
  items: TaikoItem[];
};

// ライフコーポレーションの得意先コード(参考: べんりネットは 210302999)。
// 太幸受注出力CSVの「得意先コード」列がこれと異なる行が混ざっていたら、
// ライフ以外のデータを取り込んでいる可能性が高いため警告を出す。
const LIFE_CUSTOMER_CODE = "210970188";

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

function toNum(s: string | undefined): number {
  if (!s) return 0;
  const n = parseFloat(s.trim().replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function fmtYen(n: number | null): string {
  if (n === null || Number.isNaN(n)) return "―";
  return `¥${Math.round(n).toLocaleString("ja-JP")}`;
}

function csvEscape(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toHalfWidth(s: string): string {
  return s.replace(/[０-９Ａ-Ｚａ-ｚ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
}

/** "2026/07/25" や "20260725" など表記が違っても比較できるよう、数字だけに揃える。 */
function normalizeDate(s: string): string {
  return s.replace(/[^\d]/g, "");
}

function normalizeStoreName(s: string): string {
  return toHalfWidth(s)
    .replace(/ライフ/g, "")
    .replace(/[\s　]+/g, "")
    .replace(/[0-9]+/g, "");
}

function storeMatches(lifeStoreCode: string, lifeStoreName: string, taikoDeliveryName: string): boolean {
  const code = lifeStoreCode.trim();
  const halfWidthName = toHalfWidth(taikoDeliveryName);
  if (code && halfWidthName.includes(code)) return true;
  const a = normalizeStoreName(lifeStoreName);
  const b = normalizeStoreName(taikoDeliveryName);
  if (a && b && (b.includes(a) || a.includes(b))) return true;
  return false;
}

function normalizeItemName(s: string): string {
  return toHalfWidth(s).replace(/[\s　]+/g, "");
}

function bigrams(s: string): Set<string> {
  const set = new Set<string>();
  if (s.length <= 1) {
    if (s.length === 1) set.add(s);
    return set;
  }
  for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
  return set;
}

/** 品名同士の類似度(0〜1)。文字bi-gramのJaccard係数。 */
function nameSimilarity(a: string, b: string): number {
  const A = bigrams(normalizeItemName(a));
  const B = bigrams(normalizeItemName(b));
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  A.forEach((x) => {
    if (B.has(x)) inter++;
  });
  return inter / (A.size + B.size - inter);
}

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

function parseLifeCsv(text: string): { records: LifeLine[]; warnings: string[] } {
  const rows = Papa.parse<string[]>(text, { skipEmptyLines: true }).data;
  const required = ["伝票Ｎｏ", "納品指定日", "店コード", "店名", "品名", "数量", "単価", "他伝票No"];
  const headerIdx = findHeaderRow(rows, required);
  if (headerIdx === -1) {
    return {
      records: [],
      warnings: ["必要な列を含むヘッダー行が見つかりませんでした。ライフの受領実績CSV(output.csv)で間違いないか確認してください。"],
    };
  }
  const objs = rowsToObjects(rows, headerIdx).filter((r) => (r["品名"] || "").trim() !== "");
  const records: LifeLine[] = objs.map((r) => ({
    key: `${(r["伝票Ｎｏ"] || "").trim()}__${(r["行番号"] || "").trim()}`,
    slipNo: (r["伝票Ｎｏ"] || "").trim(),
    lineNo: (r["行番号"] || "").trim(),
    deliveryDate: (r["納品指定日"] || "").trim(),
    storeCode: (r["店コード"] || "").trim(),
    storeName: (r["店名"] || "").trim(),
    itemName: (r["品名"] || "").trim(),
    qty: toNum(r["数量"]),
    price: toNum(r["単価"]),
    amount: toNum(r["金額"]),
    otherSlipNo: (r["他伝票No"] || "").trim(),
  }));
  const warnings: string[] = [];
  if (records.length === 0) warnings.push("読み込める形式のデータ行が1件もありませんでした。");
  return { records, warnings };
}

function parseTaikoCsv(text: string): { orders: TaikoOrder[]; warnings: string[] } {
  const rows = Papa.parse<string[]>(text, { skipEmptyLines: true }).data;
  const required = ["受注番号", "客先注番", "納入先名１", "納品年月日", "品名", "受注総数量", "販売単価"];
  const headerIdx = findHeaderRow(rows, required);
  if (headerIdx === -1) {
    return {
      orders: [],
      warnings: ["必要な列を含むヘッダー行が見つかりませんでした。太幸の受注出力CSVで間違いないか確認してください。"],
    };
  }
  // 「伝票消費税」などの受注番号が空欄の集計行は、個別の受注に紐づく明細ではないため除外する。
  const objs = rowsToObjects(rows, headerIdx).filter((r) => (r["受注番号"] || "").trim() !== "");

  const orderMap = new Map<string, TaikoOrder>();
  objs.forEach((r) => {
    const orderNo = (r["受注番号"] || "").trim();
    let order = orderMap.get(orderNo);
    if (!order) {
      order = {
        orderNo,
        customerOrderNo: (r["客先注番"] || "").trim(),
        customerContact: (r["客先担当"] || "").trim(),
        customerCode: (r["得意先コード"] || "").trim(),
        deliveryName: (r["納入先名１"] || "").trim(),
        deliveryDate: (r["納品年月日"] || "").trim(),
        subject: (r["件名"] || "").trim(),
        rep: (r["営業担当"] || "").trim(),
        items: [],
      };
      orderMap.set(orderNo, order);
    }
    order.items.push({
      itemName: (r["品名"] || "").trim(),
      qty: toNum(r["受注総数量"]),
      price: toNum(r["販売単価"]),
      amount: toNum(r["金額"]),
      deliverySlipNo: (r["納品書番号"] || "").trim(),
      deliveryQty: toNum(r["納品総数量"]),
      transactionType: (r["取引区分名"] || "").trim(),
    });
  });

  const warnings: string[] = [];
  const orders = Array.from(orderMap.values());
  if (orders.length === 0) warnings.push("読み込める形式のデータ行が1件もありませんでした。");

  // ライフ以外の得意先コードが混ざっていないか確認(誤って別の得意先向けCSVを
  // アップロードした場合に気づけるようにするため)。
  const otherCodes = new Map<string, number>();
  orders.forEach((o) => {
    if (o.customerCode && o.customerCode !== LIFE_CUSTOMER_CODE) {
      otherCodes.set(o.customerCode, (otherCodes.get(o.customerCode) || 0) + 1);
    }
  });
  if (otherCodes.size > 0) {
    const detail = Array.from(otherCodes.entries())
      .map(([code, n]) => `${code}(${n}件)`)
      .join("、");
    warnings.push(
      `ライフの得意先コード(${LIFE_CUSTOMER_CODE})以外のデータが含まれています: ${detail}。ライフ向けの受注出力CSVで間違いないか確認してください。`
    );
  }

  return { orders, warnings };
}

type MatchType = "exact_key" | "date_store";

type Candidate = {
  order: TaikoOrder;
  matchType: MatchType;
  bestItem: TaikoItem | null;
  bestScore: number;
  otherItems: TaikoItem[];
};

type LifeResult = {
  line: LifeLine;
  candidates: Candidate[];
};

export default function LifeCheck() {
  const [lifeState, setLifeState] = useState<FileState>(initialFileState());
  const [taikoState, setTaikoState] = useState<FileState>(initialFileState());
  const [lifeLines, setLifeLines] = useState<LifeLine[]>([]);
  const [taikoOrders, setTaikoOrders] = useState<TaikoOrder[]>([]);
  const [lifeWarnings, setLifeWarnings] = useState<string[]>([]);
  const [taikoWarnings, setTaikoWarnings] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [confidenceFilter, setConfidenceFilter] = useState<"all" | "exact" | "need_check" | "none">("all");
  const [dragOverLife, setDragOverLife] = useState(false);
  const [dragOverTaiko, setDragOverTaiko] = useState(false);

  async function handleLifeFile(file: File) {
    setLifeState({ ...initialFileState(), fileName: file.name, loading: true });
    try {
      const { text, encoding } = await readFileSmart(file);
      const { records, warnings } = parseLifeCsv(text);
      setLifeLines(records);
      setLifeWarnings(warnings);
      setLifeState({
        fileName: file.name,
        encoding,
        loading: false,
        error: records.length === 0 ? warnings[0] || "読み込みに失敗しました。" : null,
      });
    } catch (e) {
      setLifeLines([]);
      setLifeState({ fileName: file.name, encoding: "", loading: false, error: String(e) });
    }
  }

  async function handleTaikoFile(file: File) {
    setTaikoState({ ...initialFileState(), fileName: file.name, loading: true });
    try {
      const { text, encoding } = await readFileSmart(file);
      const { orders, warnings } = parseTaikoCsv(text);
      setTaikoOrders(orders);
      setTaikoWarnings(warnings);
      setTaikoState({
        fileName: file.name,
        encoding,
        loading: false,
        error: orders.length === 0 ? warnings[0] || "読み込みに失敗しました。" : null,
      });
    } catch (e) {
      setTaikoOrders([]);
      setTaikoState({ fileName: file.name, encoding: "", loading: false, error: String(e) });
    }
  }

  function reset() {
    setLifeState(initialFileState());
    setTaikoState(initialFileState());
    setLifeLines([]);
    setTaikoOrders([]);
    setLifeWarnings([]);
    setTaikoWarnings([]);
    setSearch("");
    setConfidenceFilter("all");
  }

  const results: LifeResult[] = useMemo(() => {
    return lifeLines.map((line) => {
      const normLifeDate = normalizeDate(line.deliveryDate);
      const candidateOrders = new Map<string, MatchType>();

      if (line.otherSlipNo) {
        const exact = taikoOrders.find((o) => o.customerOrderNo && o.customerOrderNo === line.otherSlipNo);
        if (exact) candidateOrders.set(exact.orderNo, "exact_key");
      }
      taikoOrders.forEach((o) => {
        if (candidateOrders.has(o.orderNo)) return;
        if (normalizeDate(o.deliveryDate) === normLifeDate && storeMatches(line.storeCode, line.storeName, o.deliveryName)) {
          candidateOrders.set(o.orderNo, "date_store");
        }
      });

      const candidates: Candidate[] = Array.from(candidateOrders.entries()).map(([orderNo, matchType]) => {
        const order = taikoOrders.find((o) => o.orderNo === orderNo)!;
        let bestItem: TaikoItem | null = null;
        let bestScore = -1;
        order.items.forEach((it) => {
          const s = nameSimilarity(line.itemName, it.itemName);
          if (s > bestScore) {
            bestScore = s;
            bestItem = it;
          }
        });
        const otherItems = order.items
          .filter((it) => it !== bestItem)
          .sort((a, b) => nameSimilarity(line.itemName, b.itemName) - nameSimilarity(line.itemName, a.itemName))
          .slice(0, 7);
        return { order, matchType, bestItem, bestScore: bestScore < 0 ? 0 : bestScore, otherItems };
      });

      candidates.sort((a, b) => {
        if (a.matchType !== b.matchType) return a.matchType === "exact_key" ? -1 : 1;
        return b.bestScore - a.bestScore;
      });

      return { line, candidates };
    });
  }, [lifeLines, taikoOrders]);

  const summary = useMemo(() => {
    const exact = results.filter((r) => r.candidates.some((c) => c.matchType === "exact_key")).length;
    const needCheck = results.filter(
      (r) => !r.candidates.some((c) => c.matchType === "exact_key") && r.candidates.length > 0
    ).length;
    const none = results.filter((r) => r.candidates.length === 0).length;
    return { total: results.length, exact, needCheck, none };
  }, [results]);

  const filteredResults = useMemo(() => {
    let r = results;
    if (confidenceFilter === "exact") r = r.filter((x) => x.candidates.some((c) => c.matchType === "exact_key"));
    else if (confidenceFilter === "need_check")
      r = r.filter((x) => !x.candidates.some((c) => c.matchType === "exact_key") && x.candidates.length > 0);
    else if (confidenceFilter === "none") r = r.filter((x) => x.candidates.length === 0);
    if (search.trim()) {
      const s = search.trim().toLowerCase();
      r = r.filter((x) => `${x.line.storeName} ${x.line.itemName}`.toLowerCase().includes(s));
    }
    return r;
  }, [results, confidenceFilter, search]);

  function downloadCsv() {
    if (!results.length) return;
    const headers = [
      "伝票No",
      "行番号",
      "納品指定日",
      "店コード",
      "店名",
      "ライフ品名",
      "ライフ数量",
      "候補件数",
      "第1候補_判定方法",
      "第1候補_太幸受注番号",
      "第1候補_太幸品名",
      "第1候補_太幸数量",
      "第1候補_類似度",
    ];
    const lines = [headers.map(csvEscape).join(",")];
    results.forEach((r) => {
      const top = r.candidates[0];
      lines.push(
        [
          r.line.slipNo,
          r.line.lineNo,
          r.line.deliveryDate,
          r.line.storeCode,
          r.line.storeName,
          r.line.itemName,
          r.line.qty,
          r.candidates.length,
          top ? (top.matchType === "exact_key" ? "客先注番一致" : "日付・店舗一致") : "",
          top ? top.order.orderNo : "",
          top?.bestItem ? top.bestItem.itemName : "",
          top?.bestItem ? top.bestItem.qty : "",
          top ? top.bestScore.toFixed(2) : "",
        ]
          .map(csvEscape)
          .join(",")
      );
    });
    const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `ライフ照合結果_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const bothLoaded = lifeLines.length > 0 && taikoOrders.length > 0;

  return (
    <div className="page">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 12 }}>
        <div>
          <h1>ライフ照合(受注番号さがし)</h1>
          <p className="subtitle">
            ライフの受領実績CSVの各明細行について、太幸のどの受注番号に対応するかを探します。客先注番が一致すれば高精度候補として、無ければ納品日+店舗名で候補を絞り込み、品名・数量を並べて目視確認できるようにします。単価は照合には使いません。
          </p>
        </div>
        <div style={{ display: "flex", gap: 10, marginTop: 4, flexWrap: "wrap" }}>
          <a href="/profit" className="ghost-btn" style={{ textDecoration: "none" }}>
            売上利益
          </a>
          <a href="/benrinet-check" className="ghost-btn" style={{ textDecoration: "none" }}>
            べんりネット照合
          </a>
          <a href="/payable-check" className="ghost-btn" style={{ textDecoration: "none" }}>
            買掛月報照合
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
            setDragOverLife(true);
          }}
          onDragLeave={() => setDragOverLife(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOverLife(false);
            const f = e.dataTransfer.files?.[0];
            if (f) handleLifeFile(f);
          }}
          style={dragOverLife ? { outline: "2px dashed var(--direct)", outlineOffset: -2 } : undefined}
        >
          <h2 style={{ marginTop: 0, fontSize: 16 }}>① ライフ受領実績CSV</h2>
          <p className="cell-sub" style={{ margin: "0 0 8px" }}>
            ファイルをここにドラッグ&ドロップ、または下のボタンで選択してください。
          </p>
          <input
            type="file"
            accept=".csv"
            disabled={lifeState.loading}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) handleLifeFile(f);
              e.target.value = "";
            }}
          />
          {lifeState.fileName && (
            <div style={{ marginTop: 10, fontSize: 12.5 }}>
              <div>ファイル: {lifeState.fileName}</div>
              {lifeState.encoding && <div className="cell-sub">文字コード: {lifeState.encoding}</div>}
              {lifeState.loading && <div style={{ color: "var(--direct)" }}>読み込み中…</div>}
              {!lifeState.loading && lifeLines.length > 0 && (
                <div style={{ color: "var(--good)" }}>{lifeLines.length.toLocaleString("ja-JP")}件を読み込みました</div>
              )}
              {lifeState.error && <div style={{ color: "var(--critical)" }}>{lifeState.error}</div>}
              {lifeWarnings.map((w, i) => (
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
            setDragOverTaiko(true);
          }}
          onDragLeave={() => setDragOverTaiko(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOverTaiko(false);
            const f = e.dataTransfer.files?.[0];
            if (f) handleTaikoFile(f);
          }}
          style={dragOverTaiko ? { outline: "2px dashed var(--direct)", outlineOffset: -2 } : undefined}
        >
          <h2 style={{ marginTop: 0, fontSize: 16 }}>② 太幸受注出力CSV(ライフ分)</h2>
          <p style={{ margin: "0 0 8px", fontSize: 13 }}>
            基幹システムからダウンロードする際の得意先コード: <strong>{LIFE_CUSTOMER_CODE}</strong>(ライフ)
          </p>
          <p className="cell-sub" style={{ margin: "0 0 8px" }}>
            ファイルをここにドラッグ&ドロップ、または下のボタンで選択してください。
          </p>
          <input
            type="file"
            accept=".csv"
            disabled={taikoState.loading}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) handleTaikoFile(f);
              e.target.value = "";
            }}
          />
          {taikoState.fileName && (
            <div style={{ marginTop: 10, fontSize: 12.5 }}>
              <div>ファイル: {taikoState.fileName}</div>
              {taikoState.encoding && <div className="cell-sub">文字コード: {taikoState.encoding}</div>}
              {taikoState.loading && <div style={{ color: "var(--direct)" }}>読み込み中…</div>}
              {!taikoState.loading && taikoOrders.length > 0 && (
                <div style={{ color: "var(--good)" }}>{taikoOrders.length.toLocaleString("ja-JP")}件の受注を読み込みました</div>
              )}
              {taikoState.error && <div style={{ color: "var(--critical)" }}>{taikoState.error}</div>}
              {taikoWarnings.map((w, i) => (
                <div key={i} style={{ color: "var(--warning)" }}>
                  {w}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {(lifeLines.length > 0 || taikoOrders.length > 0) && (
        <div className="filter-actions" style={{ marginTop: -8, marginBottom: 20 }}>
          <button className="ghost-btn" onClick={reset}>
            リセット
          </button>
        </div>
      )}

      {bothLoaded && (
        <>
          <div className="kpi-row">
            <div className="kpi-tile" style={{ cursor: "pointer" }} onClick={() => setConfidenceFilter("all")}>
              <div className="label">ライフ明細件数</div>
              <div className="value">{summary.total.toLocaleString("ja-JP")}</div>
            </div>
            <div className="kpi-tile" style={{ cursor: "pointer" }} onClick={() => setConfidenceFilter("exact")}>
              <div className="label">客先注番で自動一致</div>
              <div className="value" style={{ color: "var(--good)" }}>
                {summary.exact.toLocaleString("ja-JP")}
              </div>
            </div>
            <div className="kpi-tile" style={{ cursor: "pointer" }} onClick={() => setConfidenceFilter("need_check")}>
              <div className="label">日付・店舗のみ(要確認)</div>
              <div className="value" style={{ color: summary.needCheck > 0 ? "var(--warning)" : undefined }}>
                {summary.needCheck.toLocaleString("ja-JP")}
              </div>
            </div>
            <div className="kpi-tile" style={{ cursor: "pointer" }} onClick={() => setConfidenceFilter("none")}>
              <div className="label">候補なし</div>
              <div className="value" style={{ color: summary.none > 0 ? "var(--critical)" : undefined }}>
                {summary.none.toLocaleString("ja-JP")}
              </div>
            </div>
          </div>

          <div className="card" style={{ marginTop: 20 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
              <h2 style={{ margin: 0 }}>明細ごとの候補一覧</h2>
              <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                <div className="segmented">
                  <button className={confidenceFilter === "all" ? "active" : ""} onClick={() => setConfidenceFilter("all")}>
                    すべて({results.length})
                  </button>
                  <button className={confidenceFilter === "exact" ? "active" : ""} onClick={() => setConfidenceFilter("exact")}>
                    客先注番一致({summary.exact})
                  </button>
                  <button
                    className={confidenceFilter === "need_check" ? "active" : ""}
                    onClick={() => setConfidenceFilter("need_check")}
                  >
                    要確認({summary.needCheck})
                  </button>
                  <button className={confidenceFilter === "none" ? "active" : ""} onClick={() => setConfidenceFilter("none")}>
                    候補なし({summary.none})
                  </button>
                </div>
                <input
                  type="text"
                  placeholder="店名・品名で検索"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  style={{ padding: "7px 9px", border: "1px solid var(--border)", borderRadius: 6, fontSize: 13, minWidth: 200 }}
                />
                <button className="ghost-btn" onClick={downloadCsv} disabled={!results.length}>
                  結果をCSVでダウンロード
                </button>
              </div>
            </div>

            <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 14 }}>
              {filteredResults.length === 0 && <div className="empty-state">この条件に一致するデータはありません</div>}
              {filteredResults.map((r) => (
                <div key={r.line.key} className="record-panel">
                  <div className="record-head">
                    <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
                      <div style={{ fontSize: 13 }}>
                        <strong>{r.line.storeName}</strong>
                        <span className="cell-sub"> (店コード{r.line.storeCode})</span>
                        <span className="cell-sub"> ／ 納品指定日 {r.line.deliveryDate}</span>
                        <span className="cell-sub"> ／ 伝票No {r.line.slipNo}-{r.line.lineNo}</span>
                        {r.line.otherSlipNo && <span className="cell-sub"> ／ 他伝票No {r.line.otherSlipNo}</span>}
                      </div>
                      <div>
                        {r.candidates.length === 0 && <span className="badge critical">候補なし</span>}
                        {r.candidates.some((c) => c.matchType === "exact_key") && <span className="badge good">客先注番一致</span>}
                        {!r.candidates.some((c) => c.matchType === "exact_key") && r.candidates.length > 0 && (
                          <span className="badge warning">要確認({r.candidates.length}候補)</span>
                        )}
                      </div>
                    </div>
                    <div style={{ marginTop: 6, fontSize: 14 }}>
                      ライフ品名: <strong>{r.line.itemName}</strong>
                      <span style={{ marginLeft: 14, fontSize: 16, fontWeight: 700 }}>数量 {r.line.qty}</span>
                      <span className="cell-sub" style={{ marginLeft: 10 }}>
                        (単価{fmtYen(r.line.price)}・照合には使用していません)
                      </span>
                    </div>
                  </div>
                  <div className="record-body" style={{ maxHeight: "none" }}>
                    {r.candidates.length === 0 && (
                      <div className="record-item cell-sub">
                        同じ納品日・店舗の太幸受注が見つかりませんでした。手入力での確認が必要です。
                      </div>
                    )}
                    {r.candidates.map((c) => (
                      <div key={c.order.orderNo} className="record-item">
                        <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 8, marginBottom: 6 }}>
                          <div>
                            <span className={c.matchType === "exact_key" ? "badge good" : "badge neutral"}>
                              {c.matchType === "exact_key" ? "客先注番一致" : "日付・店舗一致"}
                            </span>
                            {(() => {
                              // 取引区分名は「売上」区分の受注であることを示すだけで、実際に
                              // 納品(出荷)済みかどうかは納品書番号・納品数量が入っているかで判断する。
                              // ここが0/空欄のまま「売上済」表示になっていたのは誤りだったため修正。
                              if (!c.bestItem) return <span className="badge neutral">品目未確認</span>;
                              const delivered = !!c.bestItem.deliverySlipNo && c.bestItem.deliverySlipNo !== "0" && c.bestItem.deliveryQty !== 0;
                              if (delivered) return <span className="badge good">売上済</span>;
                              return <span className="badge warning">未売上(今回処理対象)</span>;
                            })()}
                            <strong style={{ marginLeft: 8 }}>受注番号 {c.order.orderNo}</strong>
                            {c.order.customerCode && <span className="cell-sub"> ／ 得意先{c.order.customerCode}</span>}
                            {c.order.customerContact && <span className="cell-sub"> ／ {c.order.customerContact}</span>}
                            {c.order.subject && <span className="cell-sub"> ／ {c.order.subject}</span>}
                          </div>
                        </div>
                        {c.bestItem && (
                          <div
                            style={{
                              display: "grid",
                              gridTemplateColumns: "1fr 1fr",
                              gap: 10,
                              padding: "8px 10px",
                              borderRadius: 6,
                              background:
                                c.bestScore < 0.15
                                  ? "rgba(107,114,128,0.08)"
                                  : Math.abs(c.bestItem.qty - r.line.qty) < 0.001
                                  ? "rgba(30,125,69,0.08)"
                                  : "rgba(220,180,40,0.10)",
                            }}
                          >
                            <div>
                              <div className="cell-sub">ライフ</div>
                              <div>{r.line.itemName}</div>
                              <div style={{ fontSize: 18, fontWeight: 700 }}>数量 {r.line.qty}</div>
                            </div>
                            <div>
                              <div className="cell-sub">太幸(最も似ている品目)</div>
                              <div>{c.bestItem.itemName}</div>
                              <div
                                style={{
                                  fontSize: 18,
                                  fontWeight: 700,
                                  color: Math.abs(c.bestItem.qty - r.line.qty) < 0.001 ? "var(--good)" : "var(--critical)",
                                }}
                              >
                                数量 {c.bestItem.qty}
                              </div>
                              <div
                                className={
                                  c.bestItem.deliverySlipNo && c.bestItem.deliverySlipNo !== "0" && c.bestItem.deliveryQty !== 0
                                    ? "cell-sub"
                                    : undefined
                                }
                                style={{
                                  marginTop: 2,
                                  color:
                                    c.bestItem.deliverySlipNo && c.bestItem.deliverySlipNo !== "0" && c.bestItem.deliveryQty !== 0
                                      ? undefined
                                      : "var(--warning)",
                                  fontWeight:
                                    c.bestItem.deliverySlipNo && c.bestItem.deliverySlipNo !== "0" && c.bestItem.deliveryQty !== 0
                                      ? undefined
                                      : 600,
                                }}
                              >
                                納品書番号 {c.bestItem.deliverySlipNo || "―"} ／ 納品数量 {c.bestItem.deliveryQty}
                              </div>
                            </div>
                          </div>
                        )}
                        {c.bestScore < 0.15 && (
                          <div className="cell-sub" style={{ marginTop: 4, color: "var(--warning)" }}>
                            品名があまり似ていません。この受注の他の品目も確認してください。
                          </div>
                        )}
                        {c.otherItems.length > 0 && (
                          <details style={{ marginTop: 6 }}>
                            <summary className="cell-sub" style={{ cursor: "pointer" }}>
                              この受注の他の品目({c.otherItems.length}件)
                            </summary>
                            <table style={{ marginTop: 6, width: "100%", tableLayout: "fixed" }}>
                              <tbody>
                                {c.otherItems.map((it, i) => (
                                  <tr key={i}>
                                    <td style={{ wordBreak: "break-all" }}>{it.itemName}</td>
                                    <td className="num" style={{ whiteSpace: "nowrap" }}>
                                      数量 {it.qty}
                                    </td>
                                    <td className="cell-sub" style={{ whiteSpace: "nowrap" }}>
                                      納品書{it.deliverySlipNo || "―"}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </details>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
