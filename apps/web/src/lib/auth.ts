import type { NextAuthOptions } from "next-auth";
import { getServerSession } from "next-auth/next";
import GithubProvider from "next-auth/providers/github";

/**
 * Parse the ADMIN_GITHUB_USERS env var into a Set of lowercase usernames.
 * Returns an empty Set if the var is not set.
 */
function parseAllowedUsers(): Set<string> {
  const raw = process.env.ADMIN_GITHUB_USERS ?? "";
  if (!raw.trim()) return new Set();
  return new Set(
    raw
      .split(",")
      .map((u) => u.trim().toLowerCase())
      .filter(Boolean),
  );
}

/**
 * Check if a GitHub username is in the admin allowlist.
 */
export function isAllowedUser(username: string): boolean {
  const allowed = parseAllowedUsers();
  // If no allowlist is configured, deny all (fail-closed)
  if (allowed.size === 0) return false;
  return allowed.has(username.toLowerCase());
}

/**
 * NextAuth.js configuration with GitHub OAuth provider.
 *
 * Required env vars:
 *   GITHUB_CLIENT_ID      — GitHub OAuth App client ID
 *   GITHUB_CLIENT_SECRET  — GitHub OAuth App client secret
 *   NEXTAUTH_SECRET       — Random secret for signing JWTs (openssl rand -base64 32)
 *   ADMIN_GITHUB_USERS    — Comma-separated list of allowed GitHub usernames
 *
 * If GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET are not set, the provider list
 * is empty and the auth system is effectively disabled (open for local dev).
 */
export const authOptions: NextAuthOptions = {
  providers: [
    ...(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET
      ? [
          GithubProvider({
            clientId: process.env.GITHUB_CLIENT_ID,
            clientSecret: process.env.GITHUB_CLIENT_SECRET,
          }),
        ]
      : []),
  ],

  callbacks: {
    async signIn({ profile }) {
      const username = (profile as { login?: string })?.login;
      if (!username) return false;
      return isAllowedUser(username);
    },

    async jwt({ token, profile }) {
      // Persist GitHub username in the JWT so we can check it later
      if (profile) {
        token.githubLogin = (profile as { login?: string })?.login ?? null;
      }
      return token;
    },

    async session({ session, token }) {
      // Expose GitHub username in the session object
      if (session.user) {
        (session.user as { githubLogin?: string | null }).githubLogin =
          (token.githubLogin as string | null) ?? null;
      }
      return session;
    },
  },

  pages: {
    signIn: "/login",
    error: "/login",
  },

  session: {
    strategy: "jwt",
    // 30-day session lifetime
    maxAge: 60 * 60 * 24 * 30,
  },
};

/**
 * Check whether the current request has a valid admin session.
 * Call from Server Components or Route Handlers (uses next-auth getServerSession).
 *
 * Returns false when OAuth is not configured (dev mode / no-auth deployments).
 */
export async function isAdmin(): Promise<boolean> {
  const oauthConfigured =
    !!process.env.GITHUB_CLIENT_ID &&
    !!process.env.GITHUB_CLIENT_SECRET &&
    !!process.env.NEXTAUTH_SECRET;
  if (!oauthConfigured) return false;

  const session = await getServerSession(authOptions);
  return !!session;
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
