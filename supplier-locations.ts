// 仕入先コード(社内間金額機能で「メーカー直送」「手配」区分の場所を判定するのに使うコード)の
// マスタデータ。2026-08-03にユーザーからいただいた「仕入先マスタ.csv」の内容をそのまま定数化した。
//
// 重要: このコード体系は出荷場所コード/拠点コード(BRANCH_NAMES)とは全くの別物で、
// 数字が同じでも意味が違う(例: 出荷場所コード21=東京だが、仕入先コード21=金沢)。
// 絶対に BRANCH_NAMES と直接突き合わせて使ってはいけない。
//
// ユーザー説明(2026-08-03): 「仕入先コードは、昔の人がつけた番号。意味が不明すぎて
// 覚えにくいので、私が100＋拠点コードで新たに作成した。121が東京のように。
// なので、仕入先コードで拠点は基本二つ存在している。」
// →つまり同じ拠点を指す仕入先コードが「昔からのコード」と「100+拠点コード」の
// 2つ存在するケースが多い(例: 12と121はどちらも東京)。branchCode が同じもの同士は
// 集計上まとめて1つの拠点として扱ってよい。
//
// branchCode が入っているものは BRANCH_NAMES(拠点コード)の対応する拠点コード。
// 拠点コードに対応するものが無い(自社の業務部門・工場など、拠点コード表には
// 存在しない場所)場合は branchCode: null とし、name(略式名称)だけで表示する。
// excluded: true のものは、場所そのものではない(運賃・値引き・経費)ため、
// 社内間金額の集計対象から除外する。
export const SUPPLIER_LOCATIONS: Record<
  string,
  { name: string; branchCode: string | null; excluded?: boolean }
> = {
  "1": { name: "鳴尾倉庫", branchCode: null },
  "2": { name: "運賃", branchCode: null, excluded: true },
  "3": { name: "値引き", branchCode: null, excluded: true },
  "4": { name: "鳴尾　素地", branchCode: null },
  "5": { name: "社内仕入（海外事業部）", branchCode: "51" },
  "6": { name: "鳴尾　塗装", branchCode: null },
  "7": { name: "経費", branchCode: null, excluded: true },
  "11": { name: "太幸福岡", branchCode: "2" },
  "12": { name: "太幸東京", branchCode: "21" },
  "13": { name: "太幸名古屋", branchCode: "25" },
  "14": { name: "太幸大宮", branchCode: null },
  "15": { name: "太幸静岡", branchCode: "27" },
  "16": { name: "太幸京都", branchCode: "5" },
  "17": { name: "太幸横浜", branchCode: "22" },
  "18": { name: "太幸仙台", branchCode: "24" },
  "19": { name: "太幸広島", branchCode: "3" },
  "21": { name: "太幸金沢", branchCode: "6" },
  "22": { name: "太幸高松", branchCode: "7" },
  "23": { name: "太幸神戸", branchCode: "12" },
  "24": { name: "太幸神戸", branchCode: "12" },
  "26": { name: "太幸長野", branchCode: "9" },
  "27": { name: "太幸札幌", branchCode: "23" },
  "28": { name: "太幸新潟", branchCode: "26" },
  "29": { name: "太幸盛岡", branchCode: "29" },
  "30": { name: "太幸海外部", branchCode: "51" },
  "31": { name: "太幸介護", branchCode: null },
  "32": { name: "太幸寿司ロボット", branchCode: "61" },
  "33": { name: "太幸　奈良工場", branchCode: null },
  "91": { name: "土浦物流センター", branchCode: "91" },
  "102": { name: "太幸福岡", branchCode: "2" },
  "103": { name: "太幸広島", branchCode: "3" },
  "105": { name: "太幸京都", branchCode: "5" },
  "106": { name: "太幸金沢", branchCode: "6" },
  "107": { name: "太幸高松", branchCode: "7" },
  "109": { name: "太幸長野", branchCode: "9" },
  "121": { name: "太幸東京", branchCode: "21" },
  "122": { name: "太幸横浜", branchCode: "22" },
  "123": { name: "太幸札幌", branchCode: "23" },
  "124": { name: "太幸仙台", branchCode: "24" },
  "125": { name: "太幸名古屋", branchCode: "25" },
  "127": { name: "太幸静岡", branchCode: "27" },
  "151": { name: "太幸海外部", branchCode: "51" },
  "161": { name: "太幸寿司ロボット", branchCode: "61" },
};
