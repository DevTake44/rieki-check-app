import { NextRequest, NextResponse } from "next/server";
import { searchPurchasePrices } from "@/lib/purchaseSearch";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const mode = searchParams.get("mode");
  const query = (searchParams.get("query") ?? "").trim();

  if (mode !== "code" && mode !== "keyword") {
    return NextResponse.json(
      { error: "modeはcodeまたはkeywordを指定してください。" },
      { status: 400 }
    );
  }
  if (query === "") {
    return NextResponse.json({ results: [], truncated: false });
  }

  try {
    const outcome = await searchPurchasePrices(mode, query);
    return NextResponse.json(outcome);
  } catch (e) {
    return NextResponse.json(
      { error: "検索中にエラーが発生しました: " + (e instanceof Error ? e.message : String(e)) },
      { status: 500 }
    );
  }
}
