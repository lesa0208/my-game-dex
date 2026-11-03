import { redirect } from "next/navigation";

/** A public landing page will live here once authentication exists. */
export default function RootPage() {
  redirect("/home");
}
