/**
 * Admin session token generation and verification.
 *
 * Token format: `timestamp:nonce:hmac`
 *   - timestamp: Unix seconds when the token was issued
 *   - nonce: 32 hex chars of random data
 *   - hmac: SHA-256 HMAC of "timestamp:nonce" keyed with ADMIN_PASSWORD
 *
 * Uses the Web Crypto API so it works in both Node.js and Edge Runtime.
 *
 * This module has NO dependency on next/headers or any server-only APIs,
 * making it safe to import from middleware.ts (Edge Runtime).
 */

/** Cookie name for the admin session. */
export const ADMIN_COOKIE_NAME = "admin_session";

/**
 * Default token lifetime in seconds (24 hours).
 * Override via the ADMIN_TOKEN_MAX_AGE_SECONDS environment variable.
 */
export const TOKEN_MAX_AGE_SECONDS = 24 * 60 * 60;

/** Get the configured token max age, falling back to the default. */
export function getTokenMaxAge(): number {
  const envVal = typeof process !== "undefined"
    ? process.env?.ADMIN_TOKEN_MAX_AGE_SECONDS
    : undefined;
  if (envVal) {
    const parsed = parseInt(envVal, 10);
    if (!isNaN(parsed) && parsed > 0) return parsed;
  }
  return TOKEN_MAX_AGE_SECONDS;
}

// ---------------------------------------------------------------------------
// Web Crypto helpers
// ---------------------------------------------------------------------------

/** Encode a string to Uint8Array. */
function encode(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

/** Convert an ArrayBuffer to a hex string. */
function bufToHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Import a password string as an HMAC CryptoKey. */
async function getHmacKey(password: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encode(password).buffer as ArrayBuffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

/** Compute HMAC-SHA256 and return as hex. */
async function hmacHex(password: string, message: string): Promise<string> {
  const key = await getHmacKey(password);
  const data = encode(message);
  const sig = await crypto.subtle.sign("HMAC", key, data.buffer as ArrayBuffer);
  return bufToHex(sig);
}

/** Constant-time comparison of two hex strings. */
async function hmacEqual(
  password: string,
  message: string,
  expectedHex: string,
): Promise<boolean> {
  const key = await getHmacKey(password);
  // Re-compute and use subtle.verify for constant-time comparison
  const sig = hexToUint8Array(expectedHex);
  if (!sig) return false;
  const data = encode(message);
  return crypto.subtle.verify(
    "HMAC",
    key,
    sig.buffer as ArrayBuffer,
    data.buffer as ArrayBuffer,
  );
}

/** Convert a hex string to Uint8Array, or null if invalid. */
function hexToUint8Array(hex: string): Uint8Array | null {
  if (hex.length % 2 !== 0) return null;
  if (!/^[0-9a-f]+$/i.test(hex)) return null;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

/** Generate 32 bytes of random hex (64 chars). */
function randomNonce(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bufToHex(bytes.buffer as ArrayBuffer);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate a new admin session token.
 *
 * @param password - The ADMIN_PASSWORD value
 * @param nowSeconds - Current Unix timestamp in seconds (for testing)
 * @returns A token string in the format "timestamp:nonce:hmac"
 */
export async function generateAdminToken(
  password: string,
  nowSeconds?: number,
): Promise<string> {
  const timestamp = nowSeconds ?? Math.floor(Date.now() / 1000);
  const nonce = randomNonce();
  const message = `${timestamp}:${nonce}`;
  const mac = await hmacHex(password, message);
  return `${timestamp}:${nonce}:${mac}`;
}

/**
 * Verify an admin session token.
 *
 * Checks:
 * 1. Token format is valid (timestamp:nonce:hmac)
 * 2. HMAC is correct for the given password
 * 3. Token has not expired (based on configurable max age)
 *
 * @param token - The token string from the cookie
 * @param password - The ADMIN_PASSWORD value
 * @param nowSeconds - Current Unix timestamp in seconds (for testing)
 * @returns true if the token is valid and not expired
 */
export async function verifyAdminToken(
  token: string,
  password: string,
  nowSeconds?: number,
): Promise<boolean> {
  if (!token || !password) return false;

  // Parse token format: "timestamp:nonce:hmac"
  const parts = token.split(":");
  if (parts.length !== 3) return false;

  const [timestampStr, nonce, mac] = parts;

  // Validate timestamp is a number
  const timestamp = parseInt(timestampStr, 10);
  if (isNaN(timestamp) || timestamp <= 0) return false;

  // Validate nonce is hex and reasonable length (64 hex chars = 32 bytes)
  if (!/^[0-9a-f]{64}$/i.test(nonce)) return false;

  // Validate HMAC is hex and correct length (64 hex chars = 32 bytes SHA-256)
  if (!/^[0-9a-f]{64}$/i.test(mac)) return false;

  // Check expiration
  const now = nowSeconds ?? Math.floor(Date.now() / 1000);
  const maxAge = getTokenMaxAge();
  if (now - timestamp > maxAge) return false;

  // Reject tokens with future timestamps (clock skew tolerance: 60 seconds)
  if (timestamp > now + 60) return false;

  // Verify HMAC (constant-time via Web Crypto subtle.verify)
  const message = `${timestampStr}:${nonce}`;
  return hmacEqual(password, message, mac);
}
