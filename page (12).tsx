import PayableCheck from "@/components/PayableCheck";

// このページはブラウザ内だけで完結する(サーバー/DBを使わない)ため、
// 他ページのようなSupabaseからのデータ取得は不要。
export const dynamic = "force-dynamic";

export default function PayableCheckPage() {
  return <PayableCheck />;
}
