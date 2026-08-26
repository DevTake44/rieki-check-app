import { redirect } from "next/navigation";

// 2026-08-26変更: 以前はこのURL("/")が値上げ検知ダッシュボードそのものだったが、
// 最初に開く画面はメニュー(TOP)にしてほしいとの要望により、値上げ検知ダッシュボードは
// /price-alerts に移動し、ここはメニューへのリダイレクトだけにした。
export default function Home() {
  redirect("/menu");
}
