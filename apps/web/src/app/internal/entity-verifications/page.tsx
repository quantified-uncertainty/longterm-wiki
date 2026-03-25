import { redirect } from "next/navigation";

// Renamed to "Source Checks" (E2200) — redirect old URL for backward compatibility
export default function EntityVerificationsRedirect() {
  redirect("/wiki/E2200");
}
