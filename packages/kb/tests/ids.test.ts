import { describe, it, expect } from "vitest";
import {
  generateId,
  generateStableId,
  generateFactId,
  contentHash,
  generateContentFactId,
} from "../src/ids";

describe("ids", () => {
  describe("generateId", () => {
    it("returns a 10-character string", () => {
      const id = generateId();
      expect(id).toHaveLength(10);
    });

    it("returns only alphanumeric characters (no - or _)", () => {
      for (let i = 0; i < 50; i++) {
        const id = generateId();
        expect(id).toMatch(/^[A-Za-z0-9]{10}$/);
      }
    });

    it("generates unique IDs on successive calls", () => {
      const ids = new Set<string>();
      for (let i = 0; i < 100; i++) {
        ids.add(generateId());
      }
      expect(ids.size).toBe(100);
    });
  });

  describe("generateStableId (deprecated alias)", () => {
    it("returns same format as generateId", () => {
      const id = generateStableId();
      expect(id).toHaveLength(10);
      expect(id).toMatch(/^[A-Za-z0-9]{10}$/);
    });
  });

  describe("generateFactId", () => {
    it("returns a 10-character alphanumeric string (same format as entity IDs)", () => {
      const id = generateFactId();
      expect(id).toHaveLength(10);
      expect(id).toMatch(/^[A-Za-z0-9]{10}$/);
    });

    it("generates unique IDs", () => {
      const ids = new Set<string>();
      for (let i = 0; i < 50; i++) {
        ids.add(generateFactId());
      }
      expect(ids.size).toBe(50);
    });
  });

  describe("contentHash", () => {
    it("is deterministic: same inputs produce same output", () => {
      const parts = ["anthropic", "revenue", "1000000000", "2024"];
      const hash1 = contentHash(parts);
      const hash2 = contentHash(parts);
      expect(hash1).toBe(hash2);
    });

    it("returns a 10-character string", () => {
      const hash = contentHash(["hello", "world"]);
      expect(hash).toHaveLength(10);
    });

    it("produces different output for different inputs", () => {
      const hash1 = contentHash(["anthropic", "revenue"]);
      const hash2 = contentHash(["openai", "revenue"]);
      expect(hash1).not.toBe(hash2);
    });

    it("distinguishes between different argument boundaries", () => {
      // "ab" + "cd" should differ from "a" + "bcd" because of null-byte separator
      const hash1 = contentHash(["ab", "cd"]);
      const hash2 = contentHash(["a", "bcd"]);
      expect(hash1).not.toBe(hash2);
    });

    it("handles empty parts array", () => {
      const hash = contentHash([]);
      expect(hash).toHaveLength(10);
    });
  });

  describe("generateContentFactId", () => {
    it("returns a 10-character string (no f_ prefix)", () => {
      const id = generateContentFactId("mK9pX3rQ7n", "revenue", 1e9, "2024");
      expect(id).toHaveLength(10);
      expect(id).toMatch(/^[A-Za-z0-9]{10}$/);
    });

    it("is deterministic: same inputs produce same output", () => {
      const id1 = generateContentFactId("mK9pX3rQ7n", "revenue", 1e9, "2024");
      const id2 = generateContentFactId("mK9pX3rQ7n", "revenue", 1e9, "2024");
      expect(id1).toBe(id2);
    });

    it("produces different output for different values", () => {
      const id1 = generateContentFactId("mK9pX3rQ7n", "revenue", 1e9, "2024");
      const id2 = generateContentFactId("mK9pX3rQ7n", "revenue", 2e9, "2024");
      expect(id1).not.toBe(id2);
    });

    it("produces different output for different subjects", () => {
      const id1 = generateContentFactId("mK9pX3rQ7n", "revenue", 1e9, "2024");
      const id2 = generateContentFactId("xY7zW8vU9t", "revenue", 1e9, "2024");
      expect(id1).not.toBe(id2);
    });

    it("handles missing asOf parameter", () => {
      const id1 = generateContentFactId("mK9pX3rQ7n", "revenue", 1e9);
      const id2 = generateContentFactId("mK9pX3rQ7n", "revenue", 1e9);
      expect(id1).toBe(id2);
    });
  });
});
