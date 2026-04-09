/**
 * Shared URL/hostname utilities used across the fetch pipeline.
 */

/**
 * Check if a hostname is a private/internal address that should be blocked (SSRF protection).
 */
export function isPrivateHost(host: string): boolean {
  return (
    host === 'localhost' || host === '127.0.0.1' || host === '[::1]' ||
    host === '::1' || host === '0.0.0.0' || host === '[::]' || host === '::' ||
    host.endsWith('.local') || host.endsWith('.internal') ||
    /^10\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^192\.168\./.test(host) || /^169\.254\./.test(host) ||
    /^fe80:/i.test(host) || /^f[cd][0-9a-f]{2}:/i.test(host) ||
    /^::ffff:127\./i.test(host) || /^::ffff:10\./i.test(host) ||
    /^::ffff:192\.168\./i.test(host) ||
    /^::ffff:172\.(1[6-9]|2\d|3[01])\./i.test(host) ||
    /^::ffff:169\.254\./i.test(host)
  );
}

/**
 * Extract hostname from a URL, returning empty string on failure.
 */
export function getHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/**
 * Check if a hostname matches any domain in a list.
 * Matches exact domain or any subdomain (e.g., "sub.example.com" matches "example.com").
 */
export function matchesDomainList(hostname: string, domains: string[]): boolean {
  return domains.some(d => hostname === d || hostname.endsWith('.' + d));
}
