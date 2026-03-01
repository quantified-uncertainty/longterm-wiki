import { cookies } from "next/headers";
import { timingSafeEqual } from "crypto";

// Re-export shared token utilities so consumers can import from one place.
// The core crypto lives in admin-token.ts (no next/headers dependency, Edge-safe).
export {
  ADMIN_COOKIE_NAME,
  generateAdminToken,
  verifyAdminToken,
  TOKEN_MAX_AGE_SECONDS,
} from "./admin-token";

// Re-export safe-redirect utility
export { isSafeRedirect } from "./safe-redirect";

/**
 * Timing-safe password comparison.
 * Prevents timing attacks that could reveal password length or content.
 *
 * Note: This uses Node.js crypto (timingSafeEqual), so it can only be used
 * in Server Components and Route Handlers — NOT in Edge Runtime (middleware).
 */
export function verifyPassword(
  provided: string,
  expected: string,
): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    // Still do a comparison to avoid short-circuiting timing leak,
    // but always return false for length mismatch.
    timingSafeEqual(a, Buffer.alloc(a.length));
    return false;
  }
  return timingSafeEqual(a, b);
}

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
