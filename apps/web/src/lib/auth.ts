import { cookies } from "next/headers";
import { createHmac, randomBytes, timingSafeEqual } from "crypto";

/** Cookie name for the admin session. */
export const ADMIN_COOKIE_NAME = "admin_session";

/**
 * Generate a signed session token: `<random-hex>.<hmac-hex>`.
 * The HMAC is keyed with ADMIN_PASSWORD so tokens can't be forged
 * without knowing the password.
 */
export function generateSessionToken(secret: string): string {
  const nonce = randomBytes(32).toString("hex");
  const hmac = createHmac("sha256", secret).update(nonce).digest("hex");
  return `${nonce}.${hmac}`;
}

/**
 * Verify a session token's HMAC signature.
 * Returns true only if the token has a valid format and its HMAC
 * matches re-computation with the given secret.
 */
export function verifySessionToken(
  token: string,
  secret: string,
): boolean {
  const dotIndex = token.indexOf(".");
  if (dotIndex === -1) return false;

  const nonce = token.slice(0, dotIndex);
  const providedHmac = token.slice(dotIndex + 1);

  // Reject obviously malformed tokens
  if (!nonce || !providedHmac) return false;

  const expectedHmac = createHmac("sha256", secret)
    .update(nonce)
    .digest("hex");

  // Timing-safe comparison to prevent timing attacks on the HMAC
  try {
    const a = Buffer.from(providedHmac, "hex");
    const b = Buffer.from(expectedHmac, "hex");
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/**
 * Timing-safe password comparison.
 * Prevents timing attacks that could reveal password length or content.
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
 * Validate a redirect URL to prevent open redirect attacks.
 * Only allows relative paths (starting with /) that don't contain
 * protocol indicators.
 */
export function isSafeRedirect(url: string): boolean {
  // Must start with / (relative path)
  if (!url.startsWith("/")) return false;
  // Block protocol-relative URLs (//evil.com)
  if (url.startsWith("//")) return false;
  // Block any embedded protocol indicators
  if (url.includes("://")) return false;
  // Block backslash variants (some browsers normalize \ to /)
  if (url.includes("\\")) return false;
  return true;
}

/**
 * Check whether the current request has a valid admin session.
 * Call from Server Components or Route Handlers (uses next/headers).
 */
export async function isAdmin(): Promise<boolean> {
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminPassword) return false;

  const cookieStore = await cookies();
  const token = cookieStore.get(ADMIN_COOKIE_NAME)?.value;
  if (!token) return false;

  return verifySessionToken(token, adminPassword);
}
