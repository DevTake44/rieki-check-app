"use client";

import { useMemo, useState } from "react";
import type { PriceIncreaseAlert } from "@/lib/types";
import { branchLabel, branchNameOnly } from "@/lib/branch-names";

type SortKey =
  | "purchase_date"
  | "assumed_cost"
  | "actual_price"
  | "gap_pct"
  | "sell_price"
  | "actual_margin_pct"
  | "impact";

function fmtYen(v: number | null | undefined) {
  if (v === null || v === undefined) return "—";
  return `¥${Math.round(v).toLocaleString("ja-JP")}`;
}

function fmtPct(v: number | null | undefined) {
  if (v === null || v === undefined) return "—";
  return `${v > 0 ? "+" : ""}${v.toFixed(1)}%`;
}

function marginBadge(pct: number | null | undefined) {
  if (pct === null || pct === undefined) return { cls: "neutral", label: "販売単価不明" };
  if (pct <= 0) return { cls: "critical", label: "赤字" };
  if (pct < 10) return { cls: "warning", label: "要注意" };
  return { cls: "good", label: "許容内" };
}

function uniqueSorted(values: (string | null | undefined)[]): string[] {
  return Array.from(new Set(values.filter((v): v is string => !!v))).sort((a, b) =>
    a.localeCompare(b, "ja")
  );
}

function csvEscape(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function shiftMonths(dateStr: string, months: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  let fy = y;
  let fm = m - months;
  while (fm <= 0) {
    fm += 12;
    fy -= 1;
  }
  return `${fy}-${String(fm).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export default function Dashboard({ rows }: { rows: PriceIncreaseAlert[] }) {
  const maxOrderDate = useMemo(() => {
    const dates = rows.map((r) => r.order_date).filter((d): d is string => !!d);
    return dates.length ? dates.reduce((a, b) => (a > b ? a : b)) : null;
  }, [rows]);

  const [branch, setBranch] = useState("");
  const [rep, setRep] = useState("");
  const [customer, setCustomer] = useState("");
  const [supplier, setSupplier] = useState("");
  const [item, setItem] = useState("");
  const [category, setCategory] = useState("");
  // 初期表示は「直近12か月」(データに含まれる最新の受注日を基準に計算)
  const [dateFrom, setDateFrom] = useState(() => (maxOrderDate ? shiftMonths(maxOrderDate, 12) : ""));
  const [dateTo, setDateTo] = useState("");
  const [period, setPeriod] = useState("12");
  const [sortKey, setSortKey] = useState<SortKey>("actual_margin_pct");
  const [sortDir, setSortDir] = useState<1 | -1>(1);

  const branches = useMemo(() => uniqueSorted(rows.map((r) => r.branch_code)), [rows]);
  const reps = useMemo(() => uniqueSorted(rows.map((r) => r.rep_code)), [rows]);
  const customers = useMemo(() => uniqueSorted(rows.map((r) => r.customer_name)), [rows]);
  const suppliers = useMemo(() => uniqueSorted(rows.map((r) => r.supplier_name)), [rows]);

  function applyPeriod(key: string) {
    setPeriod(key);
    if (key === "all" || !maxOrderDate) {
      setDateFrom("");
      setDateTo("");
    } else {
      setDateFrom(shiftMonths(maxOrderDate, parseInt(key, 10)));
      setDateTo("");
    }
  }

  const filtered = useMemo(() => {
    const c = customer.trim().toLowerCase();
    const s = supplier.trim().toLowerCase();
    const it = item.trim().toLowerCase();
    return rows.filter(
      (r) =>
        (!branch || r.branch_code === branch) &&
        (!rep || r.rep_code === rep) &&
        (!c || (r.customer_name ?? "").toLowerCase().includes(c)) &&
        (!s || (r.supplier_name ?? "").toLowerCase().includes(s)) &&
        (!it || (r.item_name ?? "").toLowerCase().includes(it)) &&
        (!category || r.category === category) &&
        (!dateFrom || (r.order_date && r.order_date >= dateFrom)) &&
        (!dateTo || (r.order_date && r.order_date <= dateTo))
    );
  }, [rows, branch, rep, customer, supplier, item, category, dateFrom, dateTo]);

  const sorted = useMemo(() => {
    return [...filtered].sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      if (av === null || av === undefined) return 1;
      if (bv === null || bv === undefined) return -1;
      const cmp = av < bv ? -1 : av > bv ? 1 : 0;
      return cmp * sortDir;
    });
  }, [filtered, sortKey, sortDir]);

  const totalImpact = filtered.reduce((s, r) => s + (r.impact ?? 0), 0);
  const redCount = filtered.filter((r) => r.actual_margin_pct !== null && r.actual_margin_pct <= 0).length;
  const lowMarginCount = filtered.filter(
    (r) => r.actual_margin_pct !== null && r.actual_margin_pct > 0 && r.actual_margin_pct < 10
  ).length;

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === 1 ? -1 : 1) as 1 | -1);
    } else {
      setSortKey(key);
      setSortDir(1);
    }
  }

  function clearAll() {
    setBranch("");
    setRep("");
    setCustomer("");
    setSupplier("");
    setItem("");
    setCategory("");
    setDateFrom("");
    setDateTo("");
    setPeriod("all");
  }

  function downloadCsv() {
    if (!sorted.length) return;
    const headers = [
      "区分", "品番", "品目", "得意先", "仕入先", "拠点", "営業担当",
      "受注日", "仕入日", "想定原価", "実際仕入単価", "差額率(%)",
      "販売単価", "実際粗利率(%)", "数量", "影響額",
    ];
    const lines = [headers.map(csvEscape).join(",")];
    sorted.forEach((a) => {
      lines.push(
        [
          a.category, a.item_code || "(コード未登録)", a.item_name, a.customer_name, a.supplier_name,
          branchLabel(a.branch_code), a.rep_code, a.order_date, a.purchase_date,
          a.assumed_cost, a.actual_price, a.gap_pct, a.sell_price,
          a.actual_margin_pct === null ? "" : a.actual_margin_pct, a.qty, a.impact,
        ]
          .map(csvEscape)
          .join(",")
      );
    });
    const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `値上げ検知一覧_${maxOrderDate ?? "export"}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  const chips: { label: string; value: string; clear: () => void }[] = [];
  if (branch) chips.push({ label: "拠点", value: branchLabel(branch), clear: () => setBranch("") });
  if (rep) chips.push({ label: "営業担当", value: rep, clear: () => setRep("") });
  if (customer) chips.push({ label: "得意先", value: customer, clear: () => setCustomer("") });
  if (supplier) chips.push({ label: "仕入先", value: supplier, clear: () => setSupplier("") });
  if (item) chips.push({ label: "品名", value: item, clear: () => setItem("") });
  if (category) chips.push({ label: "区分", value: category, clear: () => setCategory("") });
  if (dateFrom || dateTo)
    chips.push({
      label: "期間",
      value: `${dateFrom || "…"} 〜 ${dateTo || "…"}`,
      clear: () => {
        setDateFrom("");
        setDateTo("");
        setPeriod("all");
      },
    });

  const sortArrow = (key: SortKey) => (sortKey === key ? (sortDir === 1 ? "▴" : "▾") : "");

  return (
    <div className="page">
      <h1>値上げ検知ダッシュボード</h1>
      <p className="subtitle">
        突合済み {rows.length.toLocaleString("ja-JP")}件 ／ うち値上げ検知 {rows.length.toLocaleString("ja-JP")}件（全体）／
        現在の表示 {sorted.length.toLocaleString("ja-JP")}件 ／ Supabase(v_price_increase_alerts)からリアルタイムに取得
      </p>

      <div className="card" style={{ marginBottom: 20 }}>
        <h2 style={{ marginTop: 0 }}>絞り込み</h2>
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
          <div className="filter-field">
            <label>営業担当</label>
            <select value={rep} onChange={(e) => setRep(e.target.value)}>
              <option value="">すべて</option>
              {reps.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </div>
          <div className="filter-field">
            <label>得意先</label>
            <input list="customerList" value={customer} onChange={(e) => setCustomer(e.target.value)} placeholder="入力して絞り込み" />
            <datalist id="customerList">
              {customers.map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
          </div>
          <div className="filter-field">
            <label>仕入先</label>
            <input list="supplierList" value={supplier} onChange={(e) => setSupplier(e.target.value)} placeholder="入力して絞り込み" />
            <datalist id="supplierList">
              {suppliers.map((s) => (
                <option key={s} value={s} />
              ))}
            </datalist>
          </div>
        </div>
        <div className="filter-row" style={{ marginTop: 12 }}>
          <div className="filter-field">
            <label>品名検索</label>
            <input value={item} onChange={(e) => setItem(e.target.value)} placeholder="品名の一部を入力" />
          </div>
          <div className="filter-field">
            <label>区分</label>
            <select value={category} onChange={(e) => setCategory(e.target.value)}>
              <option value="">すべて</option>
              <option value="直送">直送</option>
              <option value="在庫">在庫</option>
            </select>
          </div>
          <div className="filter-field" style={{ gridColumn: "span 2" }}>
            <label>期間（受注日）</label>
            <div className="segmented">
              {[
                ["all", "全期間"],
                ["1", "直近1か月"],
                ["3", "直近3か月"],
                ["6", "直近6か月"],
                ["12", "直近12か月"],
              ].map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  className={period === key ? "active" : ""}
                  onClick={() => applyPeriod(key)}
                >
                  {label}
                </button>
              ))}
              <input type="date" value={dateFrom} onChange={(e) => { setDateFrom(e.target.value); setPeriod(""); }} />
              <input type="date" value={dateTo} onChange={(e) => { setDateTo(e.target.value); setPeriod(""); }} />
            </div>
          </div>
        </div>

        {chips.length > 0 && (
          <div className="chip-row">
            {chips.map((c, i) => (
              <span className="chip" key={i}>
                {c.label}: {c.value}
                <button type="button" onClick={c.clear} aria-label="解除">
                  ×
                </button>
              </span>
            ))}
          </div>
        )}

        <div className="filter-actions">
          <button className="ghost-btn" onClick={clearAll}>
            絞り込みを解除
          </button>
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <button className="ghost-btn" onClick={downloadCsv}>
              この一覧をCSVでダウンロード
            </button>
            <span className="result-count">{sorted.length.toLocaleString("ja-JP")}件を表示中</span>
          </div>
        </div>
      </div>

      <div className="kpi-row">
        <div className="kpi-tile">
          <div className="label">値上げ検知件数</div>
          <div className="value">{filtered.length.toLocaleString("ja-JP")}</div>
        </div>
        <div className="kpi-tile">
          <div className="label">合計影響額</div>
          <div className="value">{fmtYen(totalImpact)}</div>
        </div>
        <div className="kpi-tile">
          <div className="label">赤字転落（緊急）</div>
          <div className="value">{redCount}件</div>
        </div>
        <div className="kpi-tile">
          <div className="label">要注意（粗利10%未満）</div>
          <div className="value">{lowMarginCount}件</div>
        </div>
      </div>

      <div className="card">
        <div className="table-scroll">
          <table>
            <colgroup>
              <col style={{ width: "56px" }} />
              <col style={{ width: "15%" }} />
              <col style={{ width: "18%" }} />
              <col style={{ width: "68px" }} />
              <col style={{ width: "84px" }} />
              <col style={{ width: "84px" }} />
              <col style={{ width: "90px" }} />
              <col style={{ width: "68px" }} />
              <col style={{ width: "84px" }} />
              <col style={{ width: "120px" }} />
              <col style={{ width: "90px" }} />
            </colgroup>
            <thead>
              <tr>
                <th>区分</th>
                <th>品目</th>
                <th>得意先／仕入先</th>
                <th>拠点</th>
                <th className="num sortable-th" onClick={() => toggleSort("purchase_date")}>
                  仕入日 {sortArrow("purchase_date")}
                </th>
                <th className="num sortable-th" onClick={() => toggleSort("assumed_cost")}>
                  想定原価 {sortArrow("assumed_cost")}
                </th>
                <th className="num sortable-th" onClick={() => toggleSort("actual_price")}>
                  実際仕入単価 {sortArrow("actual_price")}
                </th>
                <th className="num sortable-th" onClick={() => toggleSort("gap_pct")}>
                  差額率 {sortArrow("gap_pct")}
                </th>
                <th className="num sortable-th" onClick={() => toggleSort("sell_price")}>
                  販売単価 {sortArrow("sell_price")}
                </th>
                <th className="num sortable-th" onClick={() => toggleSort("actual_margin_pct")}>
                  実際粗利率 {sortArrow("actual_margin_pct")}
                </th>
                <th className="num sortable-th" onClick={() => toggleSort("impact")}>
                  影響額 {sortArrow("impact")}
                </th>
              </tr>
            </thead>
            <tbody>
              {sorted.length === 0 && (
                <tr>
                  <td colSpan={11} className="empty-state">
                    この条件に一致する値上げ検知はありません
                  </td>
                </tr>
              )}
              {sorted.map((a, i) => {
                const sev = marginBadge(a.actual_margin_pct);
                return (
                  <tr key={i}>
                    <td>
                      <span
                        className={`badge clickable-cell ${a.category === "在庫" ? "cat-stock" : "cat-direct"}`}
                        onClick={() => setCategory(a.category)}
                      >
                        {a.category}
                      </span>
                    </td>
                    <td className="truncate-cell" title={a.item_name ?? ""}>
                      {a.item_name}
                      <div className="cell-sub">{a.item_code || "商品コード未登録（個別品）"}</div>
                    </td>
                    <td className="truncate-cell">
                      <span
                        className="clickable-cell"
                        title={a.customer_name ?? ""}
                        onClick={() => setCustomer(a.customer_name ?? "")}
                      >
                        {a.customer_name}
                      </span>
                      <div
                        className="cell-sub clickable-cell"
                        title={a.supplier_name ?? ""}
                        onClick={() => setSupplier(a.supplier_name ?? "")}
                      >
                        {a.supplier_name}
                      </div>
                    </td>
                    <td className="clickable-cell" onClick={() => setBranch(a.branch_code ?? "")} title={branchLabel(a.branch_code)}>
                      {branchNameOnly(a.branch_code)}
                    </td>
                    <td className="num">{a.purchase_date ?? "—"}</td>
                    <td className="num">{fmtYen(a.assumed_cost)}</td>
                    <td className="num actual-price-cell">{fmtYen(a.actual_price)}</td>
                    <td className="num">{fmtPct(a.gap_pct)}</td>
                    <td className="num">{fmtYen(a.sell_price)}</td>
                    <td className="num">
                      <span className={`badge ${sev.cls}`}>
                        {a.actual_margin_pct === null ? sev.label : `${fmtPct(a.actual_margin_pct)} ${sev.label}`}
                      </span>
                    </td>
                    <td className="num">{fmtYen(a.impact)}</td>
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
