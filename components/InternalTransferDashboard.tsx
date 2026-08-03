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
                    <td>{l.locName}</td>
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
