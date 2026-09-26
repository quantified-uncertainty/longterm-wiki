import { timingSafeEqual } from "node:crypto";

/**
 * Gate for Next.js API routes that forward WRITES to the wiki-server with
 * the server-side API key (e.g. /api/framework-review-proxy POSTs).
 *
 * Those routes are otherwise anonymous: anyone on the internet could call
 * them and the wiki-server would see a fully-authenticated request.
 *
 * Fails closed: if `LONGTERMWIKI_ADMIN_WRITE_TOKEN` is unset, every write
 * is refused. To use the admin write UI, set that env var on the Vercel
 * project and, in the browser, a cookie with the same value:
 *
 *   document.cookie = "lw_admin_token=<token>; path=/; secure; samesite=strict; max-age=2592000"
 *
 * Scripts can send the `x-lw-admin-token` header instead.
 *
 * A JSON content-type is also required, so a cross-site HTML form (which
 * can only send form/text content types without a CORS preflight) can't
 * ride on the operator's cookie.
 */

export const ADMIN_TOKEN_ENV = "LONGTERMWIKI_ADMIN_WRITE_TOKEN";
export const ADMIN_TOKEN_HEADER = "x-lw-admin-token";
export const ADMIN_TOKEN_COOKIE = "lw_admin_token";

/** Minimal request surface so this is testable without constructing a NextRequest. */
export interface AdminWriteRequest {
  headers: Headers;
  cookies: { get(name: string): { value: string } | undefined };
}

export type AdminWriteCheck =
  | { ok: true }
  | { ok: false; status: 403 | 415; error: string; message: string };

function tokensMatch(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function checkAdminWrite(request: AdminWriteRequest): AdminWriteCheck {
  const expected = process.env[ADMIN_TOKEN_ENV];
  if (!expected) {
    return {
      ok: false,
      status: 403,
      error: "writes_disabled",
      message: `Writes from the web are disabled (${ADMIN_TOKEN_ENV} is not set on this deployment).`,
    };
  }

  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    return {
      ok: false,
      status: 415,
      error: "unsupported_media_type",
      message: "Content-Type must be application/json",
    };
  }

  const given =
    request.headers.get(ADMIN_TOKEN_HEADER) ??
    request.cookies.get(ADMIN_TOKEN_COOKIE)?.value ??
    "";
  if (!given || !tokensMatch(given, expected)) {
    return {
      ok: false,
      status: 403,
      error: "forbidden",
      message: `Admin token required (set the ${ADMIN_TOKEN_COOKIE} cookie).`,
    };
  }
  return { ok: true };
}
