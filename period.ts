// 20日締めの月単位(202605, 202606, ...)で期間を扱うための共通ヘルパー。
// 元データ(202606 社内間.xlsx)や社内間金額ダッシュボードと同じルール:
// 例: 202606 は 5/21〜6/20。日付が21日以降ならその翌月の締め月に属する。
export function periodKeyFor(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  let py = y;
  let pm = m;
  if (d > 20) {
    pm += 1;
    if (pm > 12) {
      pm = 1;
      py += 1;
    }
  }
  return `${py}${String(pm).padStart(2, "0")}`;
}

export function periodRangeFor(key: string): { from: string; to: string } {
  const y = parseInt(key.slice(0, 4), 10);
  const m = parseInt(key.slice(4, 6), 10);
  let fy = y;
  let fm = m - 1;
  if (fm < 1) {
    fm = 12;
    fy -= 1;
  }
  return {
    from: `${fy}-${String(fm).padStart(2, "0")}-21`,
    to: `${y}-${String(m).padStart(2, "0")}-20`,
  };
}

export function periodLabelFor(key: string): string {
  const y = key.slice(0, 4);
  const m = parseInt(key.slice(4, 6), 10);
  const { from, to } = periodRangeFor(key);
  const fromMd = from.slice(5).replace("-", "/");
  const toMd = to.slice(5).replace("-", "/");
  return `${y}年${m}月度(${fromMd}〜${toMd})`;
}

// 決算期(1年=10月度〜翌年9月度、日付にすると9/21〜翌年9/20)関連のヘルパー。
// 「今期」「前期」の切り替えなど、1年まとめての絞り込みに使う。
const FISCAL_START_MONTH = 10;

// あるperiodKey("202606"など)が属する決算期を、期首の西暦年(10月度の年)で返す。
// 例: "202606"(2026年6月度) → 期首は2025年10月 → 2025を返す。
// 例: "202511"(2025年11月度) → 期首は2025年10月 → 2025を返す。
export function fiscalYearStartOf(periodKey: string): number {
  const y = parseInt(periodKey.slice(0, 4), 10);
  const m = parseInt(periodKey.slice(4, 6), 10);
  return m >= FISCAL_START_MONTH ? y : y - 1;
}

// 決算期(期首の西暦年で指定)に属する12個のperiodKeyを、期首月から順番に返す。
export function fiscalYearPeriods(startCalYear: number): string[] {
  const periods: string[] = [];
  for (let i = 0; i < 12; i++) {
    let m = FISCAL_START_MONTH + i;
    let y = startCalYear;
    if (m > 12) {
      m -= 12;
      y += 1;
    }
    periods.push(`${y}${String(m).padStart(2, "0")}`);
  }
  return periods;
}

export function fiscalYearRangeFor(startCalYear: number): { from: string; to: string } {
  const periods = fiscalYearPeriods(startCalYear);
  return {
    from: periodRangeFor(periods[0]).from,
    to: periodRangeFor(periods[periods.length - 1]).to,
  };
}

export function fiscalYearLabel(startCalYear: number): string {
  return `${startCalYear}年10月期(${startCalYear}/10〜${startCalYear + 1}/9)`;
}
