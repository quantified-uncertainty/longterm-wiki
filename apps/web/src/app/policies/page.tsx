import { permanentRedirect } from "next/navigation";

/**
 * /policies redirects to /legislation.
 * Policy entities are already displayed on the legislation directory page.
 */
export default function PoliciesRedirect() {
  permanentRedirect("/legislation");
}
