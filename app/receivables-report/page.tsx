import ReceivablesReport from "@/components/ReceivablesReport";

// このページはSupabaseのデータを使わず、アップロードされたCSVをブラウザ内で
// 集計するだけなので、サーバー側のデータ取得は不要。
export const dynamic = "force-dynamic";

export default function ReceivablesReportPage() {
  return <ReceivablesReport />;
}
