import { cookies } from "next/headers";

// Re-export shared token utilities so consumers can import from one place.
// The core crypto lives in admin-token.ts (no next/headers dependency, Edge-safe).
export {
  ADMIN_COOKIE_NAME,
  generateAdminToken,
  verifyAdminToken,
  TOKEN_MAX_AGE_SECONDS,
} from "./admin-token";

/**
 * Check whether the current request has a valid admin session.
 * Call from Server Components or Route Handlers (uses next/headers).
 */
export async function isAdmin(): Promise<boolean> {
  const password = process.env.ADMIN_PASSWORD;
  if (!password) return false;

  const cookieStore = await cookies();
  const token = cookieStore.get("admin_session")?.value;
  if (!token) return false;

  // Dynamic import to avoid top-level await issues in some Next.js contexts
  const { verifyAdminToken } = await import("./admin-token");
  return verifyAdminToken(token, password);
}
