// 検索用に文字列を正規化する共通処理。
// - 半角カタカナ → 全角カタカナ
// - ひらがな → カタカナ
// - 全角英数字・記号・全角スペース → 半角
// - 空白をすべて除去、英字は小文字化
// これにより「ねじ」「ネジ」「ﾈｼﾞ」のような表記ゆれが同じ文字列に揃う。
// 商品マスタの product_name_normalized 列(品名+カナ品名から生成)を検索する際に使う。

const HALFWIDTH_KATAKANA_MAP: Record<string, string> = {
  "ｱ":"ア","ｲ":"イ","ｳ":"ウ","ｴ":"エ","ｵ":"オ",
  "ｶ":"カ","ｷ":"キ","ｸ":"ク","ｹ":"ケ","ｺ":"コ",
  "ｻ":"サ","ｼ":"シ","ｽ":"ス","ｾ":"セ","ｿ":"ソ",
  "ﾀ":"タ","ﾁ":"チ","ﾂ":"ツ","ﾃ":"テ","ﾄ":"ト",
  "ﾅ":"ナ","ﾆ":"ニ","ﾇ":"ヌ","ﾈ":"ネ","ﾉ":"ノ",
  "ﾊ":"ハ","ﾋ":"ヒ","ﾌ":"フ","ﾍ":"ヘ","ﾎ":"ホ",
  "ﾏ":"マ","ﾐ":"ミ","ﾑ":"ム","ﾒ":"メ","ﾓ":"モ",
  "ﾔ":"ヤ","ﾕ":"ユ","ﾖ":"ヨ",
  "ﾗ":"ラ","ﾘ":"リ","ﾙ":"ル","ﾚ":"レ","ﾛ":"ロ",
  "ﾜ":"ワ","ｦ":"ヲ","ﾝ":"ン",
  "ｧ":"ァ","ｨ":"ィ","ｩ":"ゥ","ｪ":"ェ","ｫ":"ォ",
  "ｬ":"ャ","ｭ":"ュ","ｮ":"ョ","ｯ":"ッ","ｰ":"ー",
  "ﾞ":"゛","ﾟ":"゜",
};

const DAKUTEN_MAP: Record<string, string> = {
  "カ゛":"ガ","キ゛":"ギ","ク゛":"グ","ケ゛":"ゲ","コ゛":"ゴ",
  "サ゛":"ザ","シ゛":"ジ","ス゛":"ズ","セ゛":"ゼ","ソ゛":"ゾ",
  "タ゛":"ダ","チ゛":"ヂ","ツ゛":"ヅ","テ゛":"デ","ト゛":"ド",
  "ハ゛":"バ","ヒ゛":"ビ","フ゛":"ブ","ヘ゛":"ベ","ホ゛":"ボ",
  "ウ゛":"ヴ",
  "ハ゜":"パ","ヒ゜":"ピ","フ゜":"プ","ヘ゜":"ペ","ホ゜":"ポ",
};

function halfwidthKatakanaToFullwidth(input: string): string {
  let out = "";
  for (const ch of input) out += HALFWIDTH_KATAKANA_MAP[ch] ?? ch;
  for (const [k, v] of Object.entries(DAKUTEN_MAP)) out = out.split(k).join(v);
  return out;
}

function hiraganaToKatakana(input: string): string {
  return input.replace(/[ぁ-ゖ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) + 0x60));
}

function fullwidthAsciiToHalfwidth(input: string): string {
  return input
    .replace(/[！-～]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .replace(/　/g, " ");
}

export function normalizeForSearch(input: string | null | undefined): string {
  if (!input) return "";
  let s = input;
  s = halfwidthKatakanaToFullwidth(s);
  s = hiraganaToKatakana(s);
  s = fullwidthAsciiToHalfwidth(s);
  s = s.replace(/\s+/g, "");
  return s.toLowerCase().trim();
}
