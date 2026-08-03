"use client";

import { Fragment, useMemo, useState } from "react";
import type { InternalTransferLine, TransferPendingLine } from "@/lib/types";
import { branchLabel } from "@/lib/branch-names";

function fmtYen(v: number | null | undefined) {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  return `¥${Math.round(v).toLocaleString("ja-JP")}`;
}

function uniqueSortedNumeric(values: (string | null | undefined)[]): string[] {
  return Array.from(new Set(values.filter((v): v is string => !!v))).sort((a, b) => {
    const na = Number(a);
    const nb = Number(b);
    if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
    return a.localeCompare(b, "ja");
  });
}

function csvEscape(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// 出荷場所コード/仕入先コードの名称(例:「太幸　鳴尾倉庫」「株式会社　太幸　広島」)から、
// 社名・会社形態部分を取り除いて短い地名だけを取り出す。あくまで表示を見やすくするためのもので、
// 判定や集計のキーには使わない(集計・突合には常にコード自体を使う)。
function cleanLocName(name: string | null | undefined): string {
  if (!name) return "—";
  const stripped = name
    .replace(/^(株式会社|㈱)\s*/u, "")
    .replace(/^太幸\s*/u, "")
    .trim();
  return stripped || name.trim();
}

// 拠点コード(出荷場所コード/仕入先コード)の名前空間は営業所コードとは別物で、
// かつコード「1」が拠点コード1(大阪)ではなく鳴尾倉庫を指すなど紛らわしい例外がある
// (2026-07-31、ユーザーと確認済み)。画面・CSVのどちらでも、名称だけでなく必ず
// 実際のコード番号を併記することで、どちらの拠点コードなのか誤読しないようにする。
function locLabel(locCode: string | null | undefined, locName: string | null | undefined): string {
  const cleaned = cleanLocName(locName);
  if (!locCode || locCode === "—") return cleaned;
  return `${cleaned}(${locCode})`;
}

// 確定分(売上データ由来)と未納品(受注データ由来)を、拠点×場所コードで合算する。
// 元の「202606 社内間.xlsx」は両方をまとめた1本の内訳表だったため、CSV出力もそれに合わせる。
function mergeGroups(a: BranchGroup[], b: BranchGroup[]): BranchGroup[] {
  const byBranch = new Map<string, Map<string, { locName: string; amount: number }>>();
  for (const groups of [a, b]) {
    for (const g of groups) {
      if (!byBranch.has(g.branchCode)) byBranch.set(g.branchCode, new Map());
      const locs = byBranch.get(g.branchCode)!;
      for (const l of g.locs) {
        const key = `${l.locCode}::${l.locName}`;
        const existing = locs.get(key);
        if (existing) {
          existing.amount += l.amount;
        } else {
          locs.set(key, { locName: l.locName, amount: l.amount });
        }
      }
    }
  }
  const result: BranchGroup[] = [];
  for (const [branchCode, locs] of byBranch) {
    const locArr = Array.from(locs.entries())
      .map(([key, v]) => ({ locCode: key.split("::")[0], locName: v.locName, amount: v.amount }))
      .sort((x, y) => y.amount - x.amount);
    const subtotal = locArr.reduce((s, l) => s + l.amount, 0);
    result.push({ branchCode, subtotal, locs: locArr });
  }
  return result.sort((x, y) => {
    const nx = Number(x.branchCode);
    const ny = Number(y.branchCode);
    if (Number.isFinite(nx) && Number.isFinite(ny)) return nx - ny;
    return x.branchCode.localeCompare(y.branchCode, "ja");
  });
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

type BranchGroup = {
  branchCode: string;
  subtotal: number;
  locs: { locCode: string; locName: string; amount: number }[];
};

function groupByBranchAndLoc<T>(
  rows: T[],
  getBranch: (r: T) => string | null,
  getLocCode: (r: T) => string | null,
  getLocName: (r: T) => string | null,
  getAmount: (r: T) => number
): BranchGroup[] {
  const byBranch = new Map<string, Map<string, { locName: string; amount: number }>>();
  for (const r of rows) {
    const b = getBranch(r);
    if (!b) continue;
    const locCode = getLocCode(r) ?? "—";
    const locName = getLocName(r) ?? "—";
    const amount = getAmount(r) || 0;
    if (!byBranch.has(b)) byBranch.set(b, new Map());
    const locs = byBranch.get(b)!;
    const key = `${locCode}::${locName}`;
    const existing = locs.get(key);
    if (existing) {
      existing.amount += amount;
    } else {
      locs.set(key, { locName, amount });
    }
  }
  const result: BranchGroup[] = [];
  for (const [branchCode, locs] of byBranch) {
    const locArr = Array.from(locs.entries())
      .map(([key, v]) => ({ locCode: key.split("::")[0], locName: v.locName, amount: v.amount }))
      .sort((a, b) => b.amount - a.amount);
    const subtotal = locArr.reduce((s, l) => s + l.amount, 0);
    result.push({ branchCode, subtotal, locs: locArr });
  }
  return result.sort((a, b) => {
    const na = Number(a.branchCode);
    const nb = Number(b.branchCode);
    if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
    return a.branchCode.localeCompare(b.branchCode, "ja");
  });
}

export default function InternalTransferDashboard({
  confirmedRows,
  pendingRows,
}: {
  confirmedRows: InternalTransferLine[];
  pendingRows: TransferPendingLine[];
}) {
  const maxDeliveryDate = useMemo(() => {
    const dates = confirmedRows.map((r) => r.delivery_date).filter((d): d is string => !!d);
    return dates.length ? dates.reduce((a, b) => (a > b ? a : b)) : null;
  }, [confirmedRows]);

  const [branch, setBranch] = useState("");
  const [dateFrom, setDateFrom] = useState(() => (maxDeliveryDate ? shiftMonths(maxDeliveryDate, 1) : ""));
  const [dateTo, setDateTo] = useState("");
  const [period, setPeriod] = useState("1");

  const branches = useMemo(
    () =>
      uniqueSortedNumeric([
        ...confirmedRows.map((r) => r.branch_code),
        ...pendingRows.map((r) => r.branch_code),
      ]),
    [confirmedRows, pendingRows]
  );

  function applyPeriod(key: string) {
    setPeriod(key);
    if (key === "all" || !maxDeliveryDate) {
      setDateFrom("");
      setDateTo("");
    } else {
      setDateFrom(shiftMonths(maxDeliveryDate, parseInt(key, 10)));
      setDateTo("");
    }
  }

  const filteredConfirmed = useMemo(() => {
    return confirmedRows.filter(
      (r) =>
        (!branch || r.branch_code === branch) &&
        (!dateFrom || (r.delivery_date && r.delivery_date >= dateFrom)) &&
        (!dateTo || (r.delivery_date && r.delivery_date <= dateTo))
    );
  }, [confirmedRows, branch, dateFrom, dateTo]);

  const filteredPending = useMemo(() => {
    return pendingRows.filter((r) => !branch || r.branch_code === branch);
  }, [pendingRows, branch]);

  const confirmedGroups = useMemo(
    () =>
      groupByBranchAndLoc(
        filteredConfirmed,
        (r) => r.branch_code,
        (r) => r.loc_code,
        (r) => r.loc_name,
        (r) => r.amount
      ),
    [filteredConfirmed]
  );

  const pendingGroups = useMemo(
    () =>
      groupByBranchAndLoc(
        filteredPending,
        (r) => r.branch_code,
        (r) => r.shipping_code,
        (r) => r.shipping_name,
        (r) => (r.order_qty ?? 0) * (r.assumed_cost ?? 0)
      ),
    [filteredPending]
  );

  const confirmedTotal = confirmedGroups.reduce((s, g) => s + g.subtotal, 0);
  const pendingTotal = pendingGroups.reduce((s, g) => s + g.subtotal, 0);

  // 確定分＋未納品を拠点×場所で合算したもの。元データ(202606 社内間.xlsx)と
  // 同じ「営業所コード・場所・金額」の形でCSV出力するために使う。
  const combinedGroups = useMemo(() => mergeGroups(confirmedGroups, pendingGroups), [confirmedGroups, pendingGroups]);

  function downloadCsv() {
    if (!combinedGroups.length) return;
    const lines: string[] = [["営業所コード", "場所", "金額"].map(csvEscape).join(",")];
    let grandTotal = 0;
    combinedGroups.forEach((g) => {
      g.locs.forEach((l, i) => {
        lines.push(
          [i === 0 ? g.branchCode : "", locLabel(l.locCode, l.locName), Math.round(l.amount)]
            .map(csvEscape)
            .join(",")
        );
      });
      lines.push(["", "", Math.round(g.subtotal)].map(csvEscape).join(","));
      lines.push(["", "", ""].map(csvEscape).join(","));
      grandTotal += g.subtotal;
    });
    lines.push(["総計", "", Math.round(grandTotal)].map(csvEscape).join(","));

    const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const periodLabel = dateFrom || dateTo ? `${dateFrom || "全期間"}〜${dateTo || "現在"}` : "全期間";
    const branchSuffix = branch ? `_拠点${branch}` : "";
    a.download = `社内間金額_${periodLabel}${branchSuffix}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  const pendingSnapshotAt = useMemo(() => {
    const dates = pendingRows.map((r) => r.created_at).filter(Boolean);
    return dates.length ? dates.reduce((a, b) => (a > b ? a : b)) : null;
  }, [pendingRows]);

  function renderGroupTable(groups: BranchGroup[], locHeader: string, emptyLabel: string) {
    return (
      <div className="table-scroll">
        <table>
          <colgroup>
            <col style={{ width: "140px" }} />
            <col style={{ width: "220px" }} />
            <col style={{ width: "140px" }} />
          </colgroup>
          <thead>
            <tr>
              <th>拠点</th>
              <th>{locHeader}</th>
              <th className="num">金額</th>
            </tr>
          </thead>
          <tbody>
            {groups.length === 0 && (
              <tr>
                <td colSpan={3} className="empty-state">
                  {emptyLabel}
                </td>
              </tr>
            )}
            {groups.map((g) => (
              <Fragment key={g.branchCode}>
                {g.locs.map((l, i) => (
                  <tr key={`${g.branchCode}-${l.locCode}-${i}`}>
                    {i === 0 && (
                      <td
                        rowSpan={g.locs.length + 1}
                        className="clickable-cell"
                        onClick={() => setBranch(g.branchCode)}
                        style={{ fontWeight: 600, verticalAlign: "middle" }}
                      >
                        {branchLabel(g.branchCode)}
                      </td>
                    )}
                    <td>{locLabel(l.locCode, l.locName)}</td>
                    <td className="num">{fmtYen(l.amount)}</td>
                  </tr>
                ))}
                <tr key={`${g.branchCode}-subtotal`} style={{ background: "var(--bg)" }}>
                  <td style={{ fontWeight: 600 }}>小計</td>
                  <td className="num" style={{ fontWeight: 600 }}>
                    {fmtYen(g.subtotal)}
                  </td>
                </tr>
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <div className="page">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <h1>社内間金額</h1>
        <div style={{ display: "flex", gap: 10, marginTop: 4 }}>
          <a href="/upload" className="ghost-btn" style={{ textDecoration: "none" }}>
            データ更新
          </a>
          <a href="/" className="ghost-btn" style={{ textDecoration: "none" }}>
            ← 値上げ検知ダッシュボードへ
          </a>
        </div>
      </div>
      <p className="subtitle">
        確定分(在庫区分×出荷場所コード、メーカー直送・手配区分×仕入先コード、いずれも1〜199)＋未納品(受注データ、手配区分=在庫かつ納入先名1に「太幸」を含む)の合算です。
        {pendingSnapshotAt && (
          <> 未納品スナップショット取得: {new Date(pendingSnapshotAt).toLocaleString("ja-JP")}</>
        )}
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
          <div className="filter-field" style={{ gridColumn: "span 3" }}>
            <label>期間(納品日、確定分のみに適用。未納品は常に最新スナップショット)</label>
            <div className="segmented">
              {[
                ["all", "全期間"],
                ["1", "直近1か月"],
                ["3", "直近3か月"],
                ["6", "直近6か月"],
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
        <div className="filter-actions">
          <button className="ghost-btn" onClick={downloadCsv} disabled={!combinedGroups.length}>
            確定分＋未納品を合算してCSVでダウンロード(202606社内間.xlsxと同じ形式)
          </button>
          <span className="result-count">
            対象拠点数 {combinedGroups.length.toLocaleString("ja-JP")} ／ 合計 {fmtYen(confirmedTotal + pendingTotal)}
          </span>
        </div>
      </div>

      <div className="kpi-row">
        <div className="kpi-tile">
          <div className="label">確定分合計(期間内)</div>
          <div className="value">{fmtYen(confirmedTotal)}</div>
        </div>
        <div className="kpi-tile">
          <div className="label">未納品合計(現在)</div>
          <div className="value">{fmtYen(pendingTotal)}</div>
        </div>
        <div className="kpi-tile">
          <div className="label">合計(確定＋未納品)</div>
          <div className="value">{fmtYen(confirmedTotal + pendingTotal)}</div>
        </div>
        <div className="kpi-tile">
          <div className="label">対象拠点数</div>
          <div className="value">{branch ? 1 : branches.length}</div>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 20 }}>
        <h2 style={{ marginTop: 0 }}>確定分(拠点×場所、期間内に実際に売れた分)</h2>
        {renderGroupTable(confirmedGroups, "場所", "この条件に一致するデータはありません")}
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>未納品(拠点×出荷元、まだ納品されていない移動待ち分)</h2>
        {renderGroupTable(pendingGroups, "出荷元", "現在、未納品の拠点間移動はありません")}
      </div>
    </div>
  );
}
