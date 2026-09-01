import Link from "next/link";

// ツール一覧のメニュー画面。各ツールの照合結果はSupabase等どこにも保存しないため、
// このページ自体は完全に静的なリンク集で、サーバー側のデータ取得は不要。
export const dynamic = "force-dynamic";

type ToolLink = {
  href: string;
  title: string;
  description: string;
  category: string;
};

const TOOLS: ToolLink[] = [
  {
    href: "/price-alerts",
    title: "値上げ検知ダッシュボード",
    description: "仕入・売上データから値上げの兆候を検知して一覧表示します。",
    category: "ダッシュボード",
  },
  {
    href: "/purchase-lookup",
    title: "仕入価格検索",
    description: "品番・品名から、仕入先ごとの最新価格や仕入実績の履歴を検索します。",
    category: "ダッシュボード",
  },
  {
    href: "/profit",
    title: "売上利益",
    description: "受注番号単位の売上・原価・利益を、得意先・物件・担当などで切り替えて確認します。",
    category: "ダッシュボード",
  },
  {
    href: "/internal-transfer",
    title: "社内間金額",
    description: "確定分と未納品分を合算した拠点間の社内移動金額を確認します。",
    category: "ダッシュボード",
  },
  {
    href: "/benrinet-check",
    title: "べんりネット照合",
    description: "べんりネットのCSVと自社請求出力CSVをアップロードし、客先注番+行番号で突き合わせます。",
    category: "CSV照合ツール",
  },
  {
    href: "/payable-check",
    title: "買掛月報照合",
    description: "営業所別買掛残高と買掛残高(全社)のCSVを、前月残高・総仕入額・支払額・当月残高で突き合わせます。",
    category: "CSV照合ツール",
  },
  {
    href: "/life-check",
    title: "ライフ照合(受注番号さがし)",
    description: "ライフの受領実績CSVの各明細行から、対応する太幸の受注番号を探す検索アシスタントです。",
    category: "CSV照合ツール",
  },
  {
    href: "/life-billing-check",
    title: "ライフ請求金額照合",
    description: "ライフの計上日・月末締めの請求金額と、太幸の請求出力CSVを商品行・送料/運賃ごとに突き合わせます。",
    category: "CSV照合ツール",
  },
  {
    href: "/freight-check",
    title: "運賃照合",
    description: "西濃運輸・福山通運の請求CSVを、送り状番号↔受注番号の対応データ経由で自社売上(商品コード99・運賃)と突き合わせ、請求運賃と実費の差(利益)を一覧化します。",
    category: "CSV照合ツール",
  },
  {
    href: "/receivables-report",
    title: "売掛残高月報",
    description: "拠点別の売掛残高CSVから、当月売上・消費税・入金額・当月残高の集計と、借方売掛金／貸方商品売上・仮受消費税の簡易仕訳を自動作成します。複数拠点をまとめると全社合計も表示します。",
    category: "CSV照合ツール",
  },
  {
    href: "/upload",
    title: "データ更新",
    description: "各ダッシュボードのもとになる売上・受注・仕入データをCSVからSupabaseへ取り込みます。",
    category: "データ管理",
  },
  {
    href: "/data-status",
    title: "データ更新状況",
    description: "売上・仕入・社内間・送り状問合せデータが、それぞれ今どこまで(いつの日付まで)入っているかを一覧で確認します。",
    category: "データ管理",
  },
];

const CATEGORY_ORDER = ["ダッシュボード", "CSV照合ツール", "データ管理"];

export default function MenuPage() {
  return (
    <div className="page">
      <h1>メニュー</h1>
      <p className="subtitle">利用したいツールを選んでください。CSV照合ツールはすべてブラウザ内だけで完結し、データはどこにも保存されません。</p>

      {CATEGORY_ORDER.map((category) => (
        <div key={category} style={{ marginBottom: 28 }}>
          <h2 style={{ fontSize: 15, margin: "0 0 12px" }}>{category}</h2>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
              gap: 14,
            }}
          >
            {TOOLS.filter((t) => t.category === category).map((t) => (
              <Link
                key={t.href}
                href={t.href}
                className="card"
                style={{
                  textDecoration: "none",
                  color: "inherit",
                  display: "block",
                  transition: "border-color 0.15s",
                }}
              >
                <h3 style={{ margin: "0 0 6px", fontSize: 15 }}>{t.title}</h3>
                <p className="cell-sub" style={{ margin: 0, lineHeight: 1.6 }}>
                  {t.description}
                </p>
              </Link>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
