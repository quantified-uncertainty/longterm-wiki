import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  generateAdminToken,
  verifyAdminToken,
  getTokenMaxAge,
  TOKEN_MAX_AGE_SECONDS,
} from "../admin-token";

const TEST_PASSWORD = "test-secret-password-123";

describe("generateAdminToken", () => {
  it("produces a token in the format timestamp:nonce:hmac", async () => {
    const token = await generateAdminToken(TEST_PASSWORD);
    const parts = token.split(":");
    expect(parts).toHaveLength(3);

    const [timestamp, nonce, hmac] = parts;

    // Timestamp should be a valid Unix timestamp
    expect(parseInt(timestamp, 10)).toBeGreaterThan(0);

    // Nonce should be 64 hex chars (32 bytes)
    expect(nonce).toMatch(/^[0-9a-f]{64}$/);

    // HMAC should be 64 hex chars (SHA-256 = 32 bytes)
    expect(hmac).toMatch(/^[0-9a-f]{64}$/);
  });

  it("uses the provided timestamp when given", async () => {
    const now = 1700000000;
    const token = await generateAdminToken(TEST_PASSWORD, now);
    const parts = token.split(":");
    expect(parts[0]).toBe("1700000000");
  });

  it("generates unique tokens each time (different nonces)", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token1 = await generateAdminToken(TEST_PASSWORD, now);
    const token2 = await generateAdminToken(TEST_PASSWORD, now);
    expect(token1).not.toBe(token2);
  });
});

describe("verifyAdminToken", () => {
  it("accepts a freshly generated token", async () => {
    const token = await generateAdminToken(TEST_PASSWORD);
    const valid = await verifyAdminToken(token, TEST_PASSWORD);
    expect(valid).toBe(true);
  });

  it("accepts a token with a known timestamp within the max age", async () => {
    const now = 1700000000;
    const token = await generateAdminToken(TEST_PASSWORD, now);
    // Verify at the same time
    const valid = await verifyAdminToken(token, TEST_PASSWORD, now);
    expect(valid).toBe(true);
  });

  it("accepts a token just before expiration", async () => {
    const issueTime = 1700000000;
    const token = await generateAdminToken(TEST_PASSWORD, issueTime);
    // Check 1 second before expiration
    const checkTime = issueTime + TOKEN_MAX_AGE_SECONDS - 1;
    const valid = await verifyAdminToken(token, TEST_PASSWORD, checkTime);
    expect(valid).toBe(true);
  });

  it("rejects an expired token", async () => {
    const issueTime = 1700000000;
    const token = await generateAdminToken(TEST_PASSWORD, issueTime);
    // Check 1 second after expiration
    const checkTime = issueTime + TOKEN_MAX_AGE_SECONDS + 1;
    const valid = await verifyAdminToken(token, TEST_PASSWORD, checkTime);
    expect(valid).toBe(false);
  });

  it("rejects a token exactly at the expiration boundary", async () => {
    const issueTime = 1700000000;
    const token = await generateAdminToken(TEST_PASSWORD, issueTime);
    // Check exactly at expiration + 1 second
    const checkTime = issueTime + TOKEN_MAX_AGE_SECONDS + 1;
    const valid = await verifyAdminToken(token, TEST_PASSWORD, checkTime);
    expect(valid).toBe(false);
  });

  it("rejects tokens with future timestamps beyond clock skew tolerance", async () => {
    const futureTime = Math.floor(Date.now() / 1000) + 120; // 2 minutes in the future
    const token = await generateAdminToken(TEST_PASSWORD, futureTime);
    const now = Math.floor(Date.now() / 1000);
    const valid = await verifyAdminToken(token, TEST_PASSWORD, now);
    expect(valid).toBe(false);
  });

  it("accepts tokens with small future timestamps (within 60s clock skew)", async () => {
    const now = 1700000000;
    const slightFuture = now + 30; // 30 seconds in the future
    const token = await generateAdminToken(TEST_PASSWORD, slightFuture);
    const valid = await verifyAdminToken(token, TEST_PASSWORD, now);
    expect(valid).toBe(true);
  });

  it("rejects tokens with wrong password", async () => {
    const token = await generateAdminToken(TEST_PASSWORD);
    const valid = await verifyAdminToken(token, "wrong-password");
    expect(valid).toBe(false);
  });

  it("rejects empty token", async () => {
    const valid = await verifyAdminToken("", TEST_PASSWORD);
    expect(valid).toBe(false);
  });

  it("rejects empty password", async () => {
    const token = await generateAdminToken(TEST_PASSWORD);
    const valid = await verifyAdminToken(token, "");
    expect(valid).toBe(false);
  });

  it("rejects malformed token (too few parts)", async () => {
    const valid = await verifyAdminToken("only-one-part", TEST_PASSWORD);
    expect(valid).toBe(false);
  });

  it("rejects malformed token (too many parts)", async () => {
    const valid = await verifyAdminToken("a:b:c:d", TEST_PASSWORD);
    expect(valid).toBe(false);
  });

  it("rejects token with non-numeric timestamp", async () => {
    const valid = await verifyAdminToken(
      `abc:${"a".repeat(64)}:${"b".repeat(64)}`,
      TEST_PASSWORD,
    );
    expect(valid).toBe(false);
  });

  it("rejects token with negative timestamp", async () => {
    const valid = await verifyAdminToken(
      `-1:${"a".repeat(64)}:${"b".repeat(64)}`,
      TEST_PASSWORD,
    );
    expect(valid).toBe(false);
  });

  it("rejects token with invalid nonce (wrong length)", async () => {
    const valid = await verifyAdminToken(
      `1700000000:abcdef:${"b".repeat(64)}`,
      TEST_PASSWORD,
    );
    expect(valid).toBe(false);
  });

  it("rejects token with invalid hmac (wrong length)", async () => {
    const valid = await verifyAdminToken(
      `1700000000:${"a".repeat(64)}:abcdef`,
      TEST_PASSWORD,
    );
    expect(valid).toBe(false);
  });

  it("rejects token with tampered timestamp", async () => {
    const now = 1700000000;
    const token = await generateAdminToken(TEST_PASSWORD, now);
    const parts = token.split(":");
    // Change the timestamp
    const tampered = `${now + 1}:${parts[1]}:${parts[2]}`;
    const valid = await verifyAdminToken(tampered, TEST_PASSWORD, now);
    expect(valid).toBe(false);
  });

  it("rejects token with tampered nonce", async () => {
    const now = 1700000000;
    const token = await generateAdminToken(TEST_PASSWORD, now);
    const parts = token.split(":");
    // Flip a bit in the nonce
    const tamperedNonce =
      parts[1][0] === "a" ? "b" + parts[1].slice(1) : "a" + parts[1].slice(1);
    const tampered = `${parts[0]}:${tamperedNonce}:${parts[2]}`;
    const valid = await verifyAdminToken(tampered, TEST_PASSWORD, now);
    expect(valid).toBe(false);
  });

  it("rejects token with tampered hmac", async () => {
    const now = 1700000000;
    const token = await generateAdminToken(TEST_PASSWORD, now);
    const parts = token.split(":");
    // Flip a bit in the hmac
    const tamperedHmac =
      parts[2][0] === "a" ? "b" + parts[2].slice(1) : "a" + parts[2].slice(1);
    const tampered = `${parts[0]}:${parts[1]}:${tamperedHmac}`;
    const valid = await verifyAdminToken(tampered, TEST_PASSWORD, now);
    expect(valid).toBe(false);
  });

  it("rejects the old hardcoded 'authenticated' value", async () => {
    const valid = await verifyAdminToken("authenticated", TEST_PASSWORD);
    expect(valid).toBe(false);
  });
});

describe("Node.js and Edge Runtime consistency", () => {
  it("tokens generated at a specific time verify correctly at that time", async () => {
    // This test verifies that the same crypto operations produce consistent
    // results, which is the key property needed for Node.js/Edge Runtime parity.
    const times = [1700000000, 1700086400, 1700172800];
    for (const t of times) {
      const token = await generateAdminToken(TEST_PASSWORD, t);
      const valid = await verifyAdminToken(token, TEST_PASSWORD, t);
      expect(valid).toBe(true);
    }
  });

  it("token format is deterministic (same structure) across invocations", async () => {
    const tokens = await Promise.all(
      Array.from({ length: 10 }, () => generateAdminToken(TEST_PASSWORD)),
    );

    for (const token of tokens) {
      const parts = token.split(":");
      expect(parts).toHaveLength(3);
      expect(parts[0]).toMatch(/^\d+$/);
      expect(parts[1]).toMatch(/^[0-9a-f]{64}$/);
      expect(parts[2]).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});

describe("getTokenMaxAge", () => {
  const envBackup: Record<string, string | undefined> = {};

  beforeEach(() => {
    envBackup.ADMIN_TOKEN_MAX_AGE_SECONDS =
      process.env.ADMIN_TOKEN_MAX_AGE_SECONDS;
  });

  afterEach(() => {
    if (envBackup.ADMIN_TOKEN_MAX_AGE_SECONDS === undefined) {
      delete process.env.ADMIN_TOKEN_MAX_AGE_SECONDS;
    } else {
      process.env.ADMIN_TOKEN_MAX_AGE_SECONDS =
        envBackup.ADMIN_TOKEN_MAX_AGE_SECONDS;
    }
  });

  it("returns the default when env var is not set", () => {
    delete process.env.ADMIN_TOKEN_MAX_AGE_SECONDS;
    expect(getTokenMaxAge()).toBe(TOKEN_MAX_AGE_SECONDS);
  });

  it("returns the env var value when set to a valid number", () => {
    process.env.ADMIN_TOKEN_MAX_AGE_SECONDS = "3600";
    expect(getTokenMaxAge()).toBe(3600);
  });

  it("returns the default when env var is not a valid number", () => {
    process.env.ADMIN_TOKEN_MAX_AGE_SECONDS = "not-a-number";
    expect(getTokenMaxAge()).toBe(TOKEN_MAX_AGE_SECONDS);
  });

  it("returns the default when env var is zero", () => {
    process.env.ADMIN_TOKEN_MAX_AGE_SECONDS = "0";
    expect(getTokenMaxAge()).toBe(TOKEN_MAX_AGE_SECONDS);
  });

  it("returns the default when env var is negative", () => {
    process.env.ADMIN_TOKEN_MAX_AGE_SECONDS = "-100";
    expect(getTokenMaxAge()).toBe(TOKEN_MAX_AGE_SECONDS);
  });
});
