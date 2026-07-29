// 拠点コード.csv の内容をそのまま定数化したもの。
// 将来的には拠点マスタをテーブル化してもよいが、まずはシンプルに定数で持つ。
export const BRANCH_NAMES: Record<string, string> = {
  "1": "大阪",
  "2": "福岡",
  "3": "広島",
  "4": "鹿児島",
  "5": "京都",
  "6": "金沢",
  "7": "高松",
  "8": "大阪支店※",
  "9": "長野",
  "10": "千葉",
  "12": "神戸",
  "13": "山形",
  "21": "東京",
  "22": "横浜",
  "23": "札幌",
  "24": "仙台",
  "25": "名古屋",
  "26": "新潟",
  "27": "静岡",
  "29": "盛岡",
  "50": "経理",
  "51": "海外",
  "52": "海外（東京）",
  "61": "寿司",
  "62": "友和三重",
  "63": "通販",
  "88": "東京",
  "90": "鳴尾在庫",
  "91": "土浦物流",
  "98": "友和",
  "99": "大阪支店",
};

export function branchLabel(code: string | null | undefined): string {
  if (!code) return "—";
  const name = BRANCH_NAMES[code];
  return name ? `${name}(${code})` : code;
}

// 表の中など、コードを省いて名称だけ出したい場所で使う。
// 注意: 「東京」はコード21と88の2つがあるため、名称だけだと区別が付かない場合がある。
export function branchNameOnly(code: string | null | undefined): string {
  if (!code) return "—";
  return BRANCH_NAMES[code] ?? code;
}
