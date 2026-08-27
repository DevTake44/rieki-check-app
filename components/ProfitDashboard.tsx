"use client";

import { useMemo, useRef, useState } from "react";
import type { ProfitOrder } from "@/lib/types";
import { branchLabel } from "@/lib/branch-names";
import { repLabel } from "@/lib/rep-names";
import Link from "next/link";
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
  unconfirmedCostLineCount?: number;
  unconfirmedCostRevenue?: number;
};

function groupOrders(
  orders: ProfitOrder[],
  keyFn: (o: ProfitOrder) => string,
  labelFn: (o: ProfitOrder) => string
): GroupRow[] {
  const map = new Map<
    string,
    {
      label: string;
      orderCount: number;
      revenue: number;
      cost: number;
      profit: number;
      unconfirmedCostLineCount: number;
      unconfirmedCostRevenue: number;
    }
  >();
  for (const o of orders) {
    const key = keyFn(o);
    const existing = map.get(key);
    if (existing) {
      existing.orderCount += 1;
      existing.revenue += o.revenue;
      existing.cost += o.cost;
      existing.profit += o.profit;
      existing.unconfirmedCostLineCount += o.unconfirmed_cost_line_count ?? 0;
      existing.unconfirmedCostRevenue += o.unconfirmed_cost_revenue ?? 0;
    } else {
      map.set(key, {
        label: labelFn(o),
        orderCount: 1,
        revenue: o.revenue,
        cost: o.cost,
        profit: o.profit,
        unconfirmedCostLineCount: o.unconfirmed_cost_line_count ?? 0,
        unconfirmedCostRevenue: o.unconfirmed_cost_revenue ?? 0,
      });
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

type MatDim = "branch" | "rep" | "customer";
type MatMetric = "sales" | "cost" | "profit" | "margin" | "yoy";
type MonthCell = { s: number; c: number };
type MatRow = {
  code: string;
  name: string;
  cur: MonthCell[]; // 12ヶ月(今期、10月始まり)
  prev: MonthCell[]; // 12ヶ月(前期)
  cur_ts: number;
  cur_tc: number;
  cur_tm: number | null;
  prev_ts: number;
  prev_tc: number;
  prev_ts_same: number; // 前期のうち、今期と同じ月数分だけ
  prev_tc_same: number;
};

const MAT_DIMENSIONS: { key: MatDim; label: string }[] = [
  { key: "branch", label: "拠点" },
  { key: "rep", label: "担当" },
  { key: "customer", label: "得意先" },
];

const MAT_METRICS: { key: MatMetric; label: string }[] = [
  { key: "sales", label: "売上" },
  { key: "cost", label: "原価" },
  { key: "profit", label: "利益" },
  { key: "margin", label: "粗利率" },
  { key: "yoy", label: "前年比" },
];

// 「今期計」列を並び替えるときの基準値。表示中の数値(表示する数値ボタンで選んだもの)と
// 一致させることで、クリックしたときに画面に見えている数字どおりの順番になるようにする。
function matSortValue(metric: MatMetric, row: MatRow): number {
  if (metric === "sales") return row.cur_ts;
  if (metric === "cost") return row.cur_tc;
  if (metric === "profit") return row.cur_ts - row.cur_tc;
  if (metric === "margin") return row.cur_tm ?? -Infinity;
  // yoy: 前期同期間との比較(%)。前期同期間の実績が無い行は最下位扱いにする。
  return row.prev_ts_same ? row.cur_ts / row.prev_ts_same : -Infinity;
}

function fmtSigned(n: number) {
  const r = Math.round(n);
  return `${r >= 0 ? "+" : ""}${r.toLocaleString("ja-JP")}`;
}

function matMonthCell(metric: MatMetric, cur: MonthCell, prev: MonthCell) {
  const s = cur.s;
  if (metric === "sales") {
    if (!s) return <span className="cell-sub">0</span>;
    return <span>{Math.round(s).toLocaleString("ja-JP")}</span>;
  }
  if (metric === "cost") {
    return <span>{Math.round(cur.c).toLocaleString("ja-JP")}</span>;
  }
  if (metric === "profit") {
    if (!s && !cur.c) return <span className="cell-sub">0</span>;
    const p = s - cur.c;
    return (
      <span style={{ color: p < 0 ? "var(--critical)" : "var(--good)", fontWeight: 600 }}>{fmtSigned(p)}</span>
    );
  }
  if (metric === "margin") {
    if (!s) return <span className="cell-sub">―</span>;
    const m = ((s - cur.c) / s) * 100;
    return <span style={{ color: m >= 10 ? "var(--good)" : "var(--critical)" }}>{m.toFixed(1)}%</span>;
  }
  // yoy: その月の今期売上 ÷ 前期同月売上
  if (!prev.s) return <span className="cell-sub">―</span>;
  const pct = (s / prev.s) * 100;
  return <span style={{ color: pct >= 100 ? "var(--good)" : "var(--critical)" }}>{pct.toFixed(0)}%</span>;
}

function matTotalCell(metric: MatMetric, row: MatRow) {
  if (metric === "sales") {
    return <span style={{ fontWeight: 600 }}>{fmtYen(row.cur_ts)}</span>;
  }
  if (metric === "cost") {
    return <span style={{ fontWeight: 600 }}>{fmtYen(row.cur_tc)}</span>;
  }
  if (metric === "profit") {
    const p = row.cur_ts - row.cur_tc;
    return (
      <span style={{ color: p < 0 ? "var(--critical)" : "var(--good)", fontWeight: 700 }}>{fmtYen(p)}</span>
    );
  }
  if (metric === "margin") {
    if (row.cur_tm === null) return <span className="cell-sub">―</span>;
    return (
      <span style={{ color: row.cur_tm >= 10 ? "var(--good)" : "var(--critical)", fontWeight: 700 }}>
        {row.cur_tm.toFixed(1)}%
      </span>
    );
  }
  // yoy: 総合計欄は「前期の同期間」との比較(上段)と「前期通期」の参考値(下段)の2段
  const pctSame = row.prev_ts_same ? (row.cur_ts / row.prev_ts_same) * 100 : null;
  return (
    <div>
      <div style={{ fontWeight: 700, color: pctSame === null ? undefined : pctSame >= 100 ? "var(--good)" : "var(--critical)" }}>
        {pctSame === null ? "―" : `${pctSame.toFixed(0)}%`}
      </div>
      <div className="cell-sub" style={{ marginTop: 2 }}>
        前期通期 {fmtYen(row.prev_ts)}
      </div>
    </div>
  );
}

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

  const filterCardRef = useRef<HTMLDivElement>(null);

  const [branch, setBranch] = useState("");
  const [rep, setRep] = useState("");
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
    setRep("");
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
  const reps = useMemo(() => uniqueSortedNumeric(orders.map((o) => o.rep_code)), [orders]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return orders.filter((o) => {
      if (branch && o.branch_code !== branch) return false;
      if (rep && o.rep_code !== rep) return false;
      if (dateFrom && (!o.delivery_date || o.delivery_date < dateFrom)) return false;
      if (dateTo && (!o.delivery_date || o.delivery_date > dateTo)) return false;
      if (q) {
        const hay = `${o.order_no} ${o.customer_name ?? ""} ${o.customer_code ?? ""} ${o.project_name ?? ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [orders, branch, rep, dateFrom, dateTo, search]);

  // ---- 経営マトリクス(拠点別・担当別・得意先別、決算期の今期/前期比較) ----
  // sales-dashboardの「月別マトリクス」を参考にしつつ、rieki-check側だけが持っている
  // 実際の利益(cost/profitは在庫出荷分も含めた実績)を主役にしている点が違い。
  // sales-dashboardは月締めの売上・仕入データとしては正確だが、在庫出荷の原価が
  // 反映されないため拠点別・担当別の「利益」は見られない。ここではそれが見られる。
  const [matDim, setMatDim] = useState<MatDim>("branch");
  const [matMetric, setMatMetric] = useState<MatMetric>("profit");
  const [matSortKey, setMatSortKey] = useState<"name" | "total">("total");
  const [matSortDir, setMatSortDir] = useState<1 | -1>(-1);
  const [matFilter, setMatFilter] = useState("");

  const matCurPeriods = useMemo(
    () => (currentFYStart !== undefined ? fiscalYearPeriods(currentFYStart) : []),
    [currentFYStart]
  );
  const matPrevPeriods = useMemo(
    () => (previousFYStart !== undefined ? fiscalYearPeriods(previousFYStart) : []),
    [previousFYStart]
  );

  // 会社全体で見て、今期のどの月まで実際に売上データが入っているか(=確定している月数)。
  // これが無いと、前期との「同期間」比較が正しくできない(まだ数件しか入っていない月を
  // 含めてしまうと前期側が不当に不利になる)。
  const latestPeriodIndex = useMemo(() => {
    if (!matCurPeriods.length) return -1;
    const hasData = new Array(matCurPeriods.length).fill(false);
    for (const o of orders) {
      if (!o.delivery_date || !o.revenue) continue;
      const idx = matCurPeriods.indexOf(periodKeyFor(o.delivery_date));
      if (idx !== -1) hasData[idx] = true;
    }
    let last = -1;
    hasData.forEach((v, i) => {
      if (v) last = i;
    });
    return last;
  }, [orders, matCurPeriods]);

  const matRowsAll: MatRow[] = useMemo(() => {
    if (!matCurPeriods.length) return [];
    const map = new Map<string, { name: string; cur: MonthCell[]; prev: MonthCell[] }>();
    for (const o of orders) {
      if (!o.delivery_date) continue;
      const pKey = periodKeyFor(o.delivery_date);
      const curIdx = matCurPeriods.indexOf(pKey);
      const prevIdx = matPrevPeriods.indexOf(pKey);
      if (curIdx === -1 && prevIdx === -1) continue;

      let code: string;
      let name: string;
      if (matDim === "branch") {
        code = o.branch_code || "__NONE__";
        name = branchLabel(o.branch_code);
      } else if (matDim === "rep") {
        code = o.rep_code || "__NONE__";
        name = repLabel(o.rep_code);
      } else {
        code = o.customer_code || o.customer_name || "__NONE__";
        name =
          o.customer_name && o.customer_code
            ? `${o.customer_name}(${o.customer_code})`
            : o.customer_name || o.customer_code || "(得意先不明)";
      }

      let entry = map.get(code);
      if (!entry) {
        entry = {
          name,
          cur: Array.from({ length: 12 }, () => ({ s: 0, c: 0 })),
          prev: Array.from({ length: 12 }, () => ({ s: 0, c: 0 })),
        };
        map.set(code, entry);
      }
      if (curIdx !== -1) {
        entry.cur[curIdx].s += o.revenue;
        entry.cur[curIdx].c += o.cost;
      }
      if (prevIdx !== -1) {
        entry.prev[prevIdx].s += o.revenue;
        entry.prev[prevIdx].c += o.cost;
      }
    }

    const rows: MatRow[] = [];
    for (const [code, e] of map) {
      const cur_ts = e.cur.reduce((a, c) => a + c.s, 0);
      const cur_tc = e.cur.reduce((a, c) => a + c.c, 0);
      const cur_tm = cur_ts ? ((cur_ts - cur_tc) / cur_ts) * 100 : null;
      const prev_ts = e.prev.reduce((a, c) => a + c.s, 0);
      const prev_tc = e.prev.reduce((a, c) => a + c.c, 0);
      const sameSlice = e.prev.slice(0, latestPeriodIndex + 1);
      const prev_ts_same = sameSlice.reduce((a, c) => a + c.s, 0);
      const prev_tc_same = sameSlice.reduce((a, c) => a + c.c, 0);
      rows.push({ code, name: e.name, cur: e.cur, prev: e.prev, cur_ts, cur_tc, cur_tm, prev_ts, prev_tc, prev_ts_same, prev_tc_same });
    }
    return rows;
  }, [orders, matDim, matCurPeriods, matPrevPeriods, latestPeriodIndex]);

  const CUSTOMER_MATRIX_LIMIT = 100;
  const matRows = useMemo(() => {
    let rows = matRowsAll;
    if (matFilter.trim()) {
      const f = matFilter.trim().toLowerCase();
      rows = rows.filter((r) => (r.name + r.code).toLowerCase().includes(f));
    }
    // 得意先の上位100件への絞り込みは、表示中の数値(売上/利益/粗利率など)に関わらず
    // 常に「今期売上が大きい順」で固定する(sales-dashboard側の mat_cust と同じ考え方)。
    // これを表示中の並び替えと同じ基準にしてしまうと、粗利率で並び替えたときに
    // 上位100件の顔ぶれ自体が毎回変わってしまい、何を見ているか分からなくなるため。
    if (matDim === "customer" && !matFilter.trim()) {
      rows = [...rows].sort((a, b) => b.cur_ts - a.cur_ts).slice(0, CUSTOMER_MATRIX_LIMIT);
    }
    rows = [...rows].sort((a, b) => {
      const v = matSortKey === "name" ? a.name.localeCompare(b.name, "ja") : matSortValue(matMetric, a) - matSortValue(matMetric, b);
      return v * matSortDir;
    });
    return rows;
  }, [matRowsAll, matFilter, matSortKey, matSortDir, matDim, matMetric]);

  function toggleMatSort(key: "name" | "total") {
    if (matSortKey === key) {
      setMatSortDir((d) => (d === 1 ? -1 : 1) as 1 | -1);
    } else {
      setMatSortKey(key);
      setMatSortDir(key === "name" ? 1 : -1);
    }
  }

  // マトリクスの行(拠点/担当/得意先)をクリックすると、下の「絞り込み・表示単位」
  // カードにその条件をセットして、明細まで一気に絞り込める(ドリルダウン)。
  function drillInto(row: MatRow) {
    if (row.code !== "__NONE__") {
      if (matDim === "branch") {
        setBranch(row.code);
      } else if (matDim === "rep") {
        setRep(row.code);
      } else {
        // row.name は「ファンズソリューション㈱(215000266)」のような表示用の合成文字列で、
        // 検索欄はこれをそのまま1つの文字列として含む行を探すため一致しない
        // (受注データ側には customer_name と customer_code が別々の列で入っている)。
        // row.code は customer_code(無ければ customer_name)そのものなので、これを使う。
        setSearch(row.code);
      }
    }
    setPeriodMode("fy-current");
    filterCardRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  const totals = useMemo(() => {
    return filtered.reduce(
      (acc, o) => {
        acc.revenue += o.revenue;
        acc.cost += o.cost;
        acc.profit += o.profit;
        acc.unconfirmedCostRevenue += o.unconfirmed_cost_revenue ?? 0;
        acc.unconfirmedCostLineCount += o.unconfirmed_cost_line_count ?? 0;
        return acc;
      },
      { revenue: 0, cost: 0, profit: 0, unconfirmedCostRevenue: 0, unconfirmedCostLineCount: 0 }
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
        unconfirmedCostLineCount: o.unconfirmed_cost_line_count,
        unconfirmedCostRevenue: o.unconfirmed_cost_revenue,
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
          <Link href="/internal-transfer" className="ghost-btn" style={{ textDecoration: "none" }}>
            社内間金額
          </Link>
          <Link href="/benrinet-check" className="ghost-btn" style={{ textDecoration: "none" }}>
            べんりネット照合
          </Link>
          <Link href="/payable-check" className="ghost-btn" style={{ textDecoration: "none" }}>
            買掛月報照合
          </Link>
          <Link href="/life-check" className="ghost-btn" style={{ textDecoration: "none" }}>
            ライフ照合
          </Link>
          <Link href="/life-billing-check" className="ghost-btn" style={{ textDecoration: "none" }}>
            ライフ請求金額照合
          </Link>
          <Link href="/upload" className="ghost-btn" style={{ textDecoration: "none" }}>
            データ更新
          </Link>
          <Link href="/menu" className="ghost-btn" style={{ textDecoration: "none" }}>
            ← メニューに戻る
          </Link>
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
        <h2 style={{ marginTop: 0 }}>経営マトリクス(拠点別・担当別・得意先別、今期 vs 前期)</h2>
        <p className="cell-sub" style={{ marginBottom: 12 }}>
          sales-dashboardの月次売上集計は会社全体の売上・仕入としては正確ですが、在庫出荷の原価が反映されないため拠点別・担当別の利益は見られません。
          こちらは在庫出荷分の原価も含めた実際の利益なので、個人・得意先ごとの実績を見るのに使えます。名前をクリックすると、その条件で下の明細まで絞り込めます。
        </p>
        <div className="filter-row">
          <div className="filter-field" style={{ gridColumn: "span 2" }}>
            <label>集計単位</label>
            <div className="segmented">
              {MAT_DIMENSIONS.map((d) => (
                <button
                  key={d.key}
                  type="button"
                  className={matDim === d.key ? "active" : ""}
                  onClick={() => {
                    setMatDim(d.key);
                    setMatFilter("");
                  }}
                >
                  {d.label}別
                </button>
              ))}
            </div>
          </div>
          <div className="filter-field" style={{ gridColumn: "span 2" }}>
            <label>表示する数値</label>
            <div className="segmented">
              {MAT_METRICS.map((m) => (
                <button
                  key={m.key}
                  type="button"
                  className={matMetric === m.key ? "active" : ""}
                  onClick={() => setMatMetric(m.key)}
                >
                  {m.label}
                </button>
              ))}
            </div>
          </div>
        </div>
        {matDim === "customer" && (
          <div className="filter-row" style={{ marginTop: 10 }}>
            <div className="filter-field" style={{ gridColumn: "span 2" }}>
              <label>得意先名・コードで検索</label>
              <input
                type="text"
                value={matFilter}
                onChange={(e) => setMatFilter(e.target.value)}
                placeholder="例: イオン、2130029365"
                style={{ width: "100%", padding: "6px 8px", border: "1px solid var(--border)", borderRadius: 6, fontSize: 12.5 }}
              />
            </div>
          </div>
        )}
        {currentFYStart === undefined ? (
          <p className="empty-state">データがありません</p>
        ) : (
          <>
            <div className="table-scroll table-scroll-v" style={{ marginTop: 10 }}>
              <table style={{ minWidth: 220 + matCurPeriods.length * 78 + 170 }}>
                <thead>
                  <tr>
                    <th className="sortable-th" onClick={() => toggleMatSort("name")}>
                      {MAT_DIMENSIONS.find((d) => d.key === matDim)?.label}
                      {matSortKey === "name" ? (matSortDir === 1 ? " ▴" : " ▾") : ""}
                    </th>
                    {matCurPeriods.map((p) => (
                      <th key={p} className="num">
                        {parseInt(p.slice(4, 6), 10)}月
                      </th>
                    ))}
                    <th className="num sortable-th" onClick={() => toggleMatSort("total")}>
                      今期計({MAT_METRICS.find((m) => m.key === matMetric)?.label})
                      {matSortKey === "total" ? (matSortDir === 1 ? " ▴" : " ▾") : ""}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {matRows.length === 0 && (
                    <tr>
                      <td colSpan={matCurPeriods.length + 2} className="empty-state">
                        この条件に一致するデータはありません
                      </td>
                    </tr>
                  )}
                  {matRows.map((r) => (
                    <tr key={r.code}>
                      <td>
                        <span className="clickable-cell" onClick={() => drillInto(r)}>
                          {r.name}
                        </span>
                      </td>
                      {r.cur.map((c, i) => (
                        <td key={i} className="num">
                          {matMonthCell(matMetric, c, r.prev[i])}
                        </td>
                      ))}
                      <td className="num">{matTotalCell(matMetric, r)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="cell-sub" style={{ marginTop: 8 }}>
              {matDim === "customer" && !matFilter.trim()
                ? `得意先は今期売上上位${Math.min(matRowsAll.length, 100)}件(全${matRowsAll.length.toLocaleString("ja-JP")}件)を表示。検索で絞り込めます。`
                : `${matRows.length.toLocaleString("ja-JP")}件を表示中。`}
              {latestPeriodIndex >= 0 &&
                ` 前期との比較は、今期データが確定している${latestPeriodIndex + 1}ヶ月分(${fiscalYearLabel(
                  currentFYStart
                )}のうち)で揃えています。`}
            </p>
          </>
        )}
      </div>

      <div className="card" style={{ marginBottom: 20 }} ref={filterCardRef}>
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
          <div className="filter-field">
            <label>担当</label>
            <select value={rep} onChange={(e) => setRep(e.target.value)}>
              <option value="">すべて</option>
              {reps.map((r) => (
                <option key={r} value={r}>
                  {repLabel(r)}
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

      {totals.unconfirmedCostLineCount > 0 && (
        <div className="card" style={{ marginBottom: 20, padding: "12px 16px", background: "rgba(220,180,40,0.08)" }}>
          <span className="badge warning">原価未確定</span>
          <span style={{ marginLeft: 8 }}>
            この絞り込みの中に、仕入・原価がまだ確定していない売上が {totals.unconfirmedCostLineCount.toLocaleString("ja-JP")}
            件(売上額 {fmtYen(totals.unconfirmedCostRevenue)})含まれています。該当ぶんは原価不明のため、暫定的に「原価=売上(利益0円)」として上記の利益・利益率を計算しています。実際の仕入が判明すると、対象の受注・得意先・担当の利益は変わる可能性があります。一覧内の「原価未確定」マーク付き行が該当します。
          </span>
        </div>
      )}

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
                      <span className="rf-value">
                        {g.label}
                        {!!g.unconfirmedCostLineCount && (
                          <span
                            className="badge warning"
                            style={{ marginLeft: 6, padding: "0 5px", fontSize: 10 }}
                            title={`原価未確定売上 ${fmtYen(g.unconfirmedCostRevenue ?? 0)}を含む。原価が未登録のため暫定的に利益0円として計算しています。`}
                          >
                            原価未確定
                          </span>
                        )}
                      </span>
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
                      <td>
                        {g.label}
                        {!!g.unconfirmedCostLineCount && (
                          <span
                            className="badge warning"
                            style={{ marginLeft: 6, padding: "0 5px", fontSize: 10 }}
                            title={`原価未確定売上 ${fmtYen(g.unconfirmedCostRevenue ?? 0)}(${g.unconfirmedCostLineCount}件)を含む。原価が未登録のため暫定的に利益0円として計算しています。`}
                          >
                            原価未確定
                          </span>
                        )}
                      </td>
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

    </div>
  );
}
