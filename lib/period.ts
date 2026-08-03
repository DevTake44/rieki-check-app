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
