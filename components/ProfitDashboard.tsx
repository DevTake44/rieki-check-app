"use client";

import { useMemo, useState } from "react";
import type { ProfitOrder } from "@/lib/types";
import { branchLabel } from "@/lib/branch-names";
import { repLabel } from "@/lib/rep-names";
import {
  periodKeyFor,
  periodRangeFor,
  fiscalYearStartOf,
  fiscalYearPeriods,
  fiscalYearRangeFor,
  fiscalYearLabel,
} from "@/lib/period";

function fmtYen(v: number | null | undefined) {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  return `¥${Math.round(v).toLocaleString("ja-JP")}`;
}

function fmtPct(v: number | null) {
  if (v === null || Number.isNaN(v)) return "—";
  return `${v.toFixed(1)}%`;
}

function marginPct(revenue: number, profit: number): number | null {
  if (!revenue) return null;
  return (profit / revenue) * 100;
}

function csvEscape(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function uniqueSortedNumeric(values: (string | null | undefined)[]): string[] {
  return Array.from(new Set(values.filter((v): v is string => !!v))).sort((a, b) => {
    const na = Number(a);
    const nb = Number(b);
    if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
    return a.localeCompare(b, "ja");
  });
}

type Dimension = "customer" | "order" | "project" | "rep";

type GroupRow = {
  key: string;
  label: string;
  orderCount: number;
  revenue: number;
  cost: number;
  profit: number;
  // "order" (受注番号)単位のときだけ埋まる、行の詳細情報
  customerCode?: string | null;
  customerName?: string | null;
  branchCode?: string | null;
  repCode?: string | null;
  projectName?: string | null;
};

function groupOrders(
  orders: ProfitOrder[],
  keyFn: (o: ProfitOrder) => string,
  labelFn: (o: ProfitOrder) => string
): GroupRow[] {
  const map = new Map<string, { label: string; orderCount: number; revenue: number; cost: number; profit: number }>();
  for (const o of orders) {
    const key = keyFn(o);
    const existing = map.get(key);
    if (existing) {
      existing.orderCount += 1;
      existing.revenue += o.revenue;
      existing.cost += o.cost;
      existing.profit += o.profit;
    } else {
      map.set(key, { label: labelFn(o), orderCount: 1, revenue: o.revenue, cost: o.cost, profit: o.profit });
    }
  }
  return Array.from(map.entries()).map(([key, v]) => ({ key, ...v }));
}

const DIMENSIONS: { key: Dimension; label: string }[] = [
  { key: "order", label: "受注番号" },
  { key: "customer", label: "得意先" },
  { key: "project", label: "物件" },
  { key: "rep", label: "担当" },
];

type SortKey = "revenue" | "profit";

export default function ProfitDashboard({ orders }: { orders: ProfitOrder[] }) {
  const maxOrderDate = useMemo(() => {
    const dates = orders.map((o) => o.order_date).filter((d): d is string => !!d);
    return dates.length ? dates.reduce((a, b) => (a > b ? a : b)) : null;
  }, [orders]);

  const maxDeliveryDate = useMemo(() => {
    const dates = orders.map((o) => o.delivery_date).filter((d): d is string => !!d);
    return dates.length ? dates.reduce((a, b) => (a > b ? a : b)) : null;
  }, [orders]);

  // 期間(月度)キー("202606"のような形式)は、20日締めの納品日から機械的に作る。
  // 表示上は年・月のプルダウン2つだけにして、締め日の内訳(5/21〜6/20など)は
  // 裏側の絞り込み計算にのみ使う(見た目には出さない)。
  //
  // 2026-08-03追記: 当初は受注日(order_date)基準で期間を作っていたが、姉妹アプリ
  // sales-dashboard(月次売上集計)の数値と突き合わせたところ、受注日基準だと月によって
  // 数%〜50%以上の差が出ていた。原因を調査した結果、sales-dashboard側は納品日
  // (delivery_date)基準で月度を集計していることが判明。受注してから納品までにタイム
  // ラグがあるため、特に月末・月初にまたがる受注は「受注日基準の月度」と「納品日基準の
  // 月度」がずれる。納品日基準に揃えたところ、ほぼ全ての月で差が1〜1.5%以内に収まる
  // ことを確認できたため、期間の絞り込みは納品日基準に変更した。
  const availablePeriods = useMemo(() => {
    const keys = new Set<string>();
    orders.forEach((o) => {
      if (o.delivery_date) keys.add(periodKeyFor(o.delivery_date));
    });
    return Array.from(keys).sort((a, b) => b.localeCompare(a));
  }, [orders]);

  const availableYears = useMemo(() => {
    const ys = new Set(availablePeriods.map((k) => k.slice(0, 4)));
    return Array.from(ys).sort((a, b) => b.localeCompare(a));
  }, [availablePeriods]);

  // 決算期(10月始まり、9/21〜翌9/20が1期)単位での「今期」「前期」切り替え用。
  // データに含まれる決算期の期首年(10月度の年)を新しい順に並べ、先頭を今期・
  // 2番目を前期として扱う。前期分のデータがまだ無ければ前期ボタンは出さない。
  const availableFiscalYears = useMemo(() => {
    const ys = new Set(availablePeriods.map((k) => fiscalYearStartOf(k)));
    return Array.from(ys).sort((a, b) => b - a);
  }, [availablePeriods]);
  const currentFYStart = availableFiscalYears[0];
  const previousFYStart = availableFiscalYears[1];

  type PeriodMode = "all" | "fy-current" | "fy-previous" | "month";

  const [branch, setBranch] = useState("");
  const [periodMode, setPeriodMode] = useState<PeriodMode>(() =>
    availableFiscalYears.length ? "fy-current" : "all"
  );
  const [periodKey, setPeriodKey] = useState(""); // periodMode === "month" のときだけ使う
  const [dimension, setDimension] = useState<Dimension>("order");
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("profit");
  const [sortDir, setSortDir] = useState<1 | -1>(1); // 1=小さい順(赤字が上), -1=大きい順

  const selectedYear = periodMode === "month" ? periodKey.slice(0, 4) : "";
  const selectedMonth = periodMode === "month" ? periodKey.slice(4, 6) : "";

  const monthsForSelectedYear = useMemo(() => {
    if (!selectedYear) return [];
    return availablePeriods
      .filter((k) => k.startsWith(selectedYear))
      .map((k) => k.slice(4, 6))
      .sort();
  }, [availablePeriods, selectedYear]);

  function handleYearChange(y: string) {
    if (!y) {
      setPeriodMode("all");
      setPeriodKey("");
      return;
    }
    const months = availablePeriods
      .filter((k) => k.startsWith(y))
      .map((k) => k.slice(4, 6))
      .sort();
    const month = months.includes(selectedMonth) ? selectedMonth : months[months.length - 1] ?? "";
    setPeriodMode("month");
    setPeriodKey(month ? `${y}${month}` : "");
  }

  function handleMonthChange(m: string) {
    if (!selectedYear || !m) return;
    setPeriodMode("month");
    setPeriodKey(`${selectedYear}${m}`);
  }

  function resetFilters() {
    setBranch("");
    setSearch("");
    setDimension("order");
    setPeriodMode(availableFiscalYears.length ? "fy-current" : "all");
    setPeriodKey("");
    setSortKey("profit");
    setSortDir(1);
  }

  const { from: dateFrom, to: dateTo } = useMemo(() => {
    if (periodMode === "month") {
      if (!periodKey) return { from: "", to: "" };
      return periodRangeFor(periodKey);
    }
    if (periodMode === "fy-current" && currentFYStart !== undefined) {
      return fiscalYearRangeFor(currentFYStart);
    }
    if (periodMode === "fy-previous" && previousFYStart !== undefined) {
      return fiscalYearRangeFor(previousFYStart);
    }
    return { from: "", to: "" };
  }, [periodMode, periodKey, currentFYStart, previousFYStart]);

  const branches = useMemo(() => uniqueSortedNumeric(orders.map((o) => o.branch_code)), [orders]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return orders.filter((o) => {
      if (branch && o.branch_code !== branch) return false;
      if (dateFrom && (!o.delivery_date || o.delivery_date < dateFrom)) return false;
      if (dateTo && (!o.delivery_date || o.delivery_date > dateTo)) return false;
      if (q) {
        const hay = `${o.order_no} ${o.customer_name ?? ""} ${o.customer_code ?? ""} ${o.project_name ?? ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [orders, branch, dateFrom, dateTo, search]);

  // ---- 期ごとの売上一覧(得意先別・担当別、決算期1年分) ----
  const [yearlyDimension, setYearlyDimension] = useState<"customer" | "rep">("customer");
  const [yearlyFY, setYearlyFY] = useState<"current" | "previous">("current");
  const yearlyFYStart = yearlyFY === "current" ? currentFYStart : previousFYStart;
  const yearlyPeriods = useMemo(
    () => (yearlyFYStart !== undefined ? fiscalYearPeriods(yearlyFYStart) : []),
    [yearlyFYStart]
  );

  type YearlyRow = { key: string; label: string; byPeriod: Record<string, number>; total: number };

  const yearlyRows: YearlyRow[] = useMemo(() => {
    if (yearlyFYStart === undefined) return [];
    const { from, to } = fiscalYearRangeFor(yearlyFYStart);
    const map = new Map<string, YearlyRow>();
    for (const o of orders) {
      if (branch && o.branch_code !== branch) continue;
      if (!o.delivery_date || o.delivery_date < from || o.delivery_date > to) continue;
      const pKey = periodKeyFor(o.delivery_date);
      let key: string;
      let label: string;
      if (yearlyDimension === "customer") {
        key = o.customer_code || o.customer_name || "(得意先不明)";
        label =
          o.customer_name && o.customer_code
            ? `${o.customer_name}(${o.customer_code})`
            : o.customer_name || o.customer_code || "(得意先不明)";
      } else {
        key = o.rep_code || "__NONE__";
        label = repLabel(o.rep_code);
      }
      let row = map.get(key);
      if (!row) {
        row = { key, label, byPeriod: {}, total: 0 };
        map.set(key, row);
      }
      row.byPeriod[pKey] = (row.byPeriod[pKey] ?? 0) + o.revenue;
      row.total += o.revenue;
    }
    return Array.from(map.values()).sort((a, b) => b.total - a.total);
  }, [orders, branch, yearlyDimension, yearlyFYStart]);

  const totals = useMemo(() => {
    return filtered.reduce(
      (acc, o) => {
        acc.revenue += o.revenue;
        acc.cost += o.cost;
        acc.profit += o.profit;
        return acc;
      },
      { revenue: 0, cost: 0, profit: 0 }
    );
  }, [filtered]);

  const groups: GroupRow[] = useMemo(() => {
    if (dimension === "order") {
      return filtered.map((o) => ({
        key: o.order_no,
        label: o.order_no,
        orderCount: 1,
        revenue: o.revenue,
        cost: o.cost,
        profit: o.profit,
        customerCode: o.customer_code,
        customerName: o.customer_name,
        branchCode: o.branch_code,
        repCode: o.rep_code,
        projectName: o.project_name,
      }));
    }
    if (dimension === "customer") {
      return groupOrders(
        filtered,
        (o) => o.customer_code || o.customer_name || "(得意先不明)",
        (o) => {
          if (o.customer_name && o.customer_code) return `${o.customer_name}(${o.customer_code})`;
          return o.customer_name || o.customer_code || "(得意先不明)";
        }
      );
    }
    if (dimension === "project") {
      return groupOrders(
        filtered,
        (o) => o.project_name || "__NONE__",
        (o) => o.project_name || "(物件なし・通常売上)"
      );
    }
    // rep
    return groupOrders(
      filtered,
      (o) => o.rep_code || "__NONE__",
      (o) => repLabel(o.rep_code)
    );
  }, [filtered, dimension]);

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === 1 ? -1 : 1) as 1 | -1);
    } else {
      setSortKey(key);
      setSortDir(1);
    }
  }
  const sortArrow = (key: SortKey) => (sortKey === key ? (sortDir === 1 ? "▴" : "▾") : "");

  const sortedGroups = useMemo(() => {
    return [...groups].sort((a, b) => (a[sortKey] - b[sortKey]) * sortDir);
  }, [groups, sortKey, sortDir]);

  function downloadCsv() {
    if (!sortedGroups.length) return;
    const dimLabel = DIMENSIONS.find((d) => d.key === dimension)?.label ?? "";
    const periodLabel =
      periodMode === "month" && periodKey
        ? `${selectedYear}年${parseInt(selectedMonth, 10)}月`
        : periodMode === "fy-current" && currentFYStart !== undefined
        ? fiscalYearLabel(currentFYStart)
        : periodMode === "fy-previous" && previousFYStart !== undefined
        ? fiscalYearLabel(previousFYStart)
        : "全期間";

    if (dimension === "order") {
      const headers = ["得意先コード", "得意先", "拠点", "担当", "受注番号", "物件名", "売上計", "原価計", "利益", "利益率(%)"];
      const lines = [headers.map(csvEscape).join(",")];
      sortedGroups.forEach((g) => {
        const m = marginPct(g.revenue, g.profit);
        lines.push(
          [
            g.customerCode ?? "",
            g.customerName ?? "",
            branchLabel(g.branchCode ?? null),
            repLabel(g.repCode ?? null),
            g.label,
            g.projectName ?? "",
            Math.round(g.revenue),
            Math.round(g.cost),
            Math.round(g.profit),
            m === null ? "" : m.toFixed(1),
          ]
            .map(csvEscape)
            .join(",")
        );
      });
      const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `売上利益_受注別_${periodLabel}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      return;
    }

    const headers = [dimLabel, "受注件数", "売上", "原価", "利益", "利益率(%)"];
    const lines = [headers.map(csvEscape).join(",")];
    sortedGroups.forEach((g) => {
      const m = marginPct(g.revenue, g.profit);
      lines.push(
        [g.label, g.orderCount, Math.round(g.revenue), Math.round(g.cost), Math.round(g.profit), m === null ? "" : m.toFixed(1)]
          .map(csvEscape)
          .join(",")
      );
    });
    const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `売上利益_${dimLabel}別_${periodLabel}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  return (
    <div className="page">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <h1>売上利益</h1>
        <div style={{ display: "flex", gap: 10, marginTop: 4 }}>
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
      <p className="subtitle">
        受注番号単位で集計した売上・原価・利益を、受注番号・得意先・物件・担当のいずれかの単位で切り替えて見られます。
        原価は、在庫区分は売上データの原価、メーカー直送・手配区分は仕入データとの受注番号・行番号一致による実績原価(見つからない場合は売上データの原価で代用)を使っています。
        運賃・値引き等の商品外行も、実際の売上への影響としてそのまま含めています。
        年・月の絞り込みは納品日(20日締め)基準です(sales-dashboardの月次売上集計と基準を揃えています)。
        {maxOrderDate && <> データの最新受注日: {maxOrderDate}</>}
        {maxDeliveryDate && <> / 最新納品日: {maxDeliveryDate}</>}
      </p>

      <div className="card" style={{ marginBottom: 20 }}>
        <h2 style={{ marginTop: 0 }}>絞り込み・表示単位</h2>
        <div className="filter-row">
          <div className="filter-field">
            <label>拠点</label>
            <select value={branch} onChange={(e) => setBranch(e.target.value)}>
              <option value="">すべて</option>
              {branches.map((b) => (
                <option key={b} value={b}>
                  {branchLabel(b)}
                </option>
              ))}
            </select>
          </div>
          <div className="filter-field" style={{ gridColumn: "span 2" }}>
            <label>検索(得意先名・得意先コード・受注番号・物件名)</label>
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="例: イオン、2130029365、〇〇工事"
              style={{ width: "100%", padding: "6px 8px", border: "1px solid var(--border)", borderRadius: 6, fontSize: 12.5 }}
            />
          </div>
        </div>
        <div className="filter-row" style={{ marginTop: 10 }}>
          <div className="filter-field" style={{ gridColumn: "span 4" }}>
            <label>期間(決算期・10月始まり)</label>
            <div className="segmented">
              <button type="button" className={periodMode === "all" ? "active" : ""} onClick={() => setPeriodMode("all")}>
                全期間
              </button>
              {currentFYStart !== undefined && (
                <button
                  type="button"
                  className={periodMode === "fy-current" ? "active" : ""}
                  onClick={() => setPeriodMode("fy-current")}
                >
                  今期({fiscalYearLabel(currentFYStart)})
                </button>
              )}
              {previousFYStart !== undefined ? (
                <button
                  type="button"
                  className={periodMode === "fy-previous" ? "active" : ""}
                  onClick={() => setPeriodMode("fy-previous")}
                >
                  前期({fiscalYearLabel(previousFYStart)})
                </button>
              ) : (
                <span className="cell-sub">前期データは未アップロードです</span>
              )}
            </div>
          </div>
        </div>
        <div className="filter-row" style={{ marginTop: 10 }}>
          <div className="filter-field">
            <label>年(特定の月を指定)</label>
            <select value={selectedYear} onChange={(e) => handleYearChange(e.target.value)}>
              <option value="">—</option>
              {availableYears.map((y) => (
                <option key={y} value={y}>
                  {y}年
                </option>
              ))}
            </select>
          </div>
          <div className="filter-field">
            <label>月</label>
            <select value={selectedMonth} onChange={(e) => handleMonthChange(e.target.value)} disabled={!selectedYear}>
              {!selectedYear && <option value="">—</option>}
              {monthsForSelectedYear.map((m) => (
                <option key={m} value={m}>
                  {parseInt(m, 10)}月
                </option>
              ))}
            </select>
          </div>
          <div className="filter-field" style={{ gridColumn: "span 2" }}>
            <label>表示単位</label>
            <div className="segmented">
              {DIMENSIONS.map((d) => (
                <button
                  key={d.key}
                  type="button"
                  className={dimension === d.key ? "active" : ""}
                  onClick={() => setDimension(d.key)}
                >
                  {d.label}
                </button>
              ))}
            </div>
          </div>
        </div>
        <div className="filter-actions">
          <div style={{ display: "flex", gap: 10 }}>
            <button className="ghost-btn" onClick={resetFilters}>
              絞り込みをリセット
            </button>
            <button className="ghost-btn" onClick={downloadCsv} disabled={!sortedGroups.length}>
              この一覧をCSVでダウンロード
            </button>
          </div>
          <span className="result-count">{sortedGroups.length.toLocaleString("ja-JP")}件を表示中</span>
        </div>
      </div>

      <div className="kpi-row">
        <div className="kpi-tile">
          <div className="label">売上合計</div>
          <div className="value">{fmtYen(totals.revenue)}</div>
        </div>
        <div className="kpi-tile">
          <div className="label">原価合計</div>
          <div className="value">{fmtYen(totals.cost)}</div>
        </div>
        <div className="kpi-tile">
          <div className="label">利益合計</div>
          <div className="value" style={{ color: totals.profit < 0 ? "var(--critical)" : undefined }}>
            {fmtYen(totals.profit)}
          </div>
        </div>
        <div className="kpi-tile">
          <div className="label">利益率</div>
          <div className="value">{fmtPct(marginPct(totals.revenue, totals.profit))}</div>
        </div>
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>
          {DIMENSIONS.find((d) => d.key === dimension)?.label}別 内訳
          <span className="cell-sub" style={{ marginLeft: 12, fontWeight: 400 }}>
            「売上計」「利益」の見出しをクリックで並び替え
          </span>
        </h2>

        {dimension === "order" ? (
          <div className="record-panel">
            <div className="record-head">
              <div className="record-head-line">
                <span>得意先コード</span>
                <span>得意先</span>
                <span>拠点</span>
                <span>担当</span>
                <span>受注番号</span>
              </div>
              <div className="record-head-line">
                <span>物件名</span>
                <span className="sortable-field" onClick={() => toggleSort("revenue")}>
                  売上計 {sortArrow("revenue")}
                </span>
                <span>原価計</span>
                <span className="sortable-field" onClick={() => toggleSort("profit")}>
                  利益 {sortArrow("profit")}
                </span>
                <span>利益率</span>
              </div>
            </div>
            <div className="record-body">
              {sortedGroups.length === 0 && <div className="empty-state">この条件に一致するデータはありません</div>}
              {sortedGroups.map((g) => {
                const m = marginPct(g.revenue, g.profit);
                return (
                  <div className="record-item" key={g.key}>
                    <div className="record-line">
                      <span className="rf-value">{g.customerCode || "—"}</span>
                      <span className="rf-value">{g.customerName || "—"}</span>
                      <span className="rf-value">{branchLabel(g.branchCode ?? null)}</span>
                      <span className="rf-value">{repLabel(g.repCode ?? null)}</span>
                      <span className="rf-value">{g.label}</span>
                    </div>
                    <div className="record-line">
                      <span className="rf-value">{g.projectName || "(通常売上)"}</span>
                      <span className="rf-value num">{fmtYen(g.revenue)}</span>
                      <span className="rf-value num">{fmtYen(g.cost)}</span>
                      <span
                        className="rf-value num"
                        style={{ color: g.profit < 0 ? "var(--critical)" : undefined, fontWeight: 600 }}
                      >
                        {fmtYen(g.profit)}
                      </span>
                      <span className="rf-value num">{fmtPct(m)}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>{DIMENSIONS.find((d) => d.key === dimension)?.label}</th>
                  <th className="num">受注件数</th>
                  <th className="num sortable-th" onClick={() => toggleSort("revenue")}>
                    売上 {sortArrow("revenue")}
                  </th>
                  <th className="num">原価</th>
                  <th className="num sortable-th" onClick={() => toggleSort("profit")}>
                    利益 {sortArrow("profit")}
                  </th>
                  <th className="num">利益率</th>
                </tr>
              </thead>
              <tbody>
                {sortedGroups.length === 0 && (
                  <tr>
                    <td colSpan={6} className="empty-state">
                      この条件に一致するデータはありません
                    </td>
                  </tr>
                )}
                {sortedGroups.map((g) => {
                  const m = marginPct(g.revenue, g.profit);
                  return (
                    <tr key={g.key}>
                      <td>{g.label}</td>
                      <td className="num">{g.orderCount.toLocaleString("ja-JP")}</td>
                      <td className="num">{fmtYen(g.revenue)}</td>
                      <td className="num">{fmtYen(g.cost)}</td>
                      <td className="num" style={{ color: g.profit < 0 ? "var(--critical)" : undefined, fontWeight: 600 }}>
                        {fmtYen(g.profit)}
                      </td>
                      <td className="num">{fmtPct(m)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card" style={{ marginTop: 20 }}>
        <h2 style={{ marginTop: 0 }}>期ごとの売上一覧(得意先別・担当別、決算期1年分)</h2>
        <p className="cell-sub" style={{ marginBottom: 12 }}>
          sales-dashboardの月次売上集計と突き合わせるための一覧です。原価・利益は含まず、売上金額(納品日基準)のみを、
          決算期の10月度〜翌9月度の12ヶ月で並べています。上の「拠点」絞り込みは反映されますが、期間・表示単位の絞り込みとは連動しません。
        </p>
        <div className="filter-row">
          <div className="filter-field">
            <label>集計単位</label>
            <div className="segmented">
              <button
                type="button"
                className={yearlyDimension === "customer" ? "active" : ""}
                onClick={() => setYearlyDimension("customer")}
              >
                得意先別
              </button>
              <button
                type="button"
                className={yearlyDimension === "rep" ? "active" : ""}
                onClick={() => setYearlyDimension("rep")}
              >
                担当別
              </button>
            </div>
          </div>
          <div className="filter-field" style={{ gridColumn: "span 2" }}>
            <label>決算期</label>
            <div className="segmented">
              {currentFYStart !== undefined && (
                <button
                  type="button"
                  className={yearlyFY === "current" ? "active" : ""}
                  onClick={() => setYearlyFY("current")}
                >
                  今期({fiscalYearLabel(currentFYStart)})
                </button>
              )}
              {previousFYStart !== undefined ? (
                <button
                  type="button"
                  className={yearlyFY === "previous" ? "active" : ""}
                  onClick={() => setYearlyFY("previous")}
                >
                  前期({fiscalYearLabel(previousFYStart)})
                </button>
              ) : (
                <span className="cell-sub">前期データは未アップロードです</span>
              )}
            </div>
          </div>
        </div>
        <div className="filter-actions">
          <span className="result-count">{yearlyRows.length.toLocaleString("ja-JP")}件を表示中</span>
        </div>
        <div className="table-scroll table-scroll-v" style={{ marginTop: 10 }}>
          <table style={{ minWidth: 160 + (yearlyPeriods.length + 1) * 92 }}>
            <thead>
              <tr>
                <th>{yearlyDimension === "customer" ? "得意先" : "担当"}</th>
                {yearlyPeriods.map((p) => (
                  <th key={p} className="num">
                    {parseInt(p.slice(4, 6), 10)}月
                  </th>
                ))}
                <th className="num">合計</th>
              </tr>
            </thead>
            <tbody>
              {yearlyRows.length === 0 && (
                <tr>
                  <td colSpan={yearlyPeriods.length + 2} className="empty-state">
                    この決算期のデータはまだありません
                  </td>
                </tr>
              )}
              {yearlyRows.map((r) => (
                <tr key={r.key}>
                  <td>{r.label}</td>
                  {yearlyPeriods.map((p) => (
                    <td key={p} className="num">
                      {fmtYen(r.byPeriod[p] ?? 0)}
                    </td>
                  ))}
                  <td className="num" style={{ fontWeight: 600 }}>
                    {fmtYen(r.total)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
