"use client";

import { useMemo, useState } from "react";
import type { ProfitOrder } from "@/lib/types";
import { branchLabel } from "@/lib/branch-names";
import { repLabel } from "@/lib/rep-names";
import { periodKeyFor, periodLabelFor, periodRangeFor } from "@/lib/period";

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
  { key: "customer", label: "得意先" },
  { key: "order", label: "受注番号" },
  { key: "project", label: "物件" },
  { key: "rep", label: "担当" },
];

export default function ProfitDashboard({ orders }: { orders: ProfitOrder[] }) {
  const maxOrderDate = useMemo(() => {
    const dates = orders.map((o) => o.order_date).filter((d): d is string => !!d);
    return dates.length ? dates.reduce((a, b) => (a > b ? a : b)) : null;
  }, [orders]);

  const availablePeriods = useMemo(() => {
    const keys = new Set<string>();
    orders.forEach((o) => {
      if (o.order_date) keys.add(periodKeyFor(o.order_date));
    });
    return Array.from(keys).sort((a, b) => b.localeCompare(a));
  }, [orders]);

  const [branch, setBranch] = useState("");
  const [periodKey, setPeriodKey] = useState(() => availablePeriods[0] ?? "");
  const [dimension, setDimension] = useState<Dimension>("customer");
  const [search, setSearch] = useState("");
  const [sortAsc, setSortAsc] = useState(true); // 利益の小さい(赤字)順をデフォルトにする

  const { from: dateFrom, to: dateTo } = useMemo(() => {
    if (!periodKey) return { from: "", to: "" };
    return periodRangeFor(periodKey);
  }, [periodKey]);

  const branches = useMemo(() => uniqueSortedNumeric(orders.map((o) => o.branch_code)), [orders]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return orders.filter((o) => {
      if (branch && o.branch_code !== branch) return false;
      if (dateFrom && (!o.order_date || o.order_date < dateFrom)) return false;
      if (dateTo && (!o.order_date || o.order_date > dateTo)) return false;
      if (q) {
        const hay = `${o.order_no} ${o.customer_name ?? ""} ${o.customer_code ?? ""} ${o.project_name ?? ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [orders, branch, dateFrom, dateTo, search]);

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

  const sortedGroups = useMemo(() => {
    return [...groups].sort((a, b) => (sortAsc ? a.profit - b.profit : b.profit - a.profit));
  }, [groups, sortAsc]);

  function downloadCsv() {
    if (!sortedGroups.length) return;
    const dimLabel = DIMENSIONS.find((d) => d.key === dimension)?.label ?? "";
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
    const periodLabel = periodKey || "全期間";
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
        受注番号単位で集計した売上・原価・利益を、得意先・受注番号・物件・担当のいずれかの単位で切り替えて見られます。
        原価は、在庫区分は売上データの原価、メーカー直送・手配区分は仕入データとの受注番号・行番号一致による実績原価(見つからない場合は売上データの原価で代用)を使っています。
        運賃・値引き等の商品外行も、実際の売上への影響としてそのまま含めています。
        {maxOrderDate && <> データの最新受注日: {maxOrderDate}</>}
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
            <label>期間(受注日、20日締め)</label>
            <div className="segmented">
              <button type="button" className={periodKey === "" ? "active" : ""} onClick={() => setPeriodKey("")}>
                全期間
              </button>
              {availablePeriods.map((key) => (
                <button
                  key={key}
                  type="button"
                  className={periodKey === key ? "active" : ""}
                  onClick={() => setPeriodKey(key)}
                >
                  {periodLabelFor(key)}
                </button>
              ))}
            </div>
          </div>
        </div>
        <div className="filter-row" style={{ marginTop: 10 }}>
          <div className="filter-field" style={{ gridColumn: "span 4" }}>
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
          <button className="ghost-btn" onClick={downloadCsv} disabled={!sortedGroups.length}>
            この一覧をCSVでダウンロード
          </button>
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
          <button
            className="ghost-btn"
            style={{ marginLeft: 12, fontSize: 12 }}
            onClick={() => setSortAsc((v) => !v)}
          >
            利益{sortAsc ? "の小さい(赤字)順" : "の大きい順"} ⇅
          </button>
        </h2>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>{DIMENSIONS.find((d) => d.key === dimension)?.label}</th>
                <th className="num">受注件数</th>
                <th className="num">売上</th>
                <th className="num">原価</th>
                <th className="num">利益</th>
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
      </div>
    </div>
  );
}
