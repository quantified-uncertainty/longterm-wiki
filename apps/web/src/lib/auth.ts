import { cookies } from "next/headers";

/** Cookie name for the admin session. */
export const ADMIN_COOKIE_NAME = "admin_session";
/** Simple token value stored in the cookie when authenticated. */
export const ADMIN_TOKEN_VALUE = "authenticated";

/**
 * Check whether the current request has a valid admin session.
 * Call from Server Components or Route Handlers (uses next/headers).
 */
export async function isAdmin(): Promise<boolean> {
  if (!process.env.ADMIN_PASSWORD) return false;

  const cookieStore = await cookies();
  return cookieStore.get(ADMIN_COOKIE_NAME)?.value === ADMIN_TOKEN_VALUE;
}
