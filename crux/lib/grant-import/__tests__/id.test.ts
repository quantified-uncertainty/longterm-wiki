import { describe, it, expect } from "vitest";
import { generateId } from "../id.ts";

describe("generateId", () => {
  it("returns a 10-character string", () => {
    const id = generateId("test-input");
    expect(id).toHaveLength(10);
  });

  it("is deterministic", () => {
    const id1 = generateId("same-input");
    const id2 = generateId("same-input");
    expect(id1).toBe(id2);
  });

  it("produces different IDs for different inputs", () => {
    const id1 = generateId("input-a");
    const id2 = generateId("input-b");
    expect(id1).not.toBe(id2);
  });

  // Pinned known values — these MUST NOT change (5,000+ grants in production)
  it("matches pinned value for a CG-style grant", () => {
    const input = "coefficient-giving|ULjDXpSLCI|Machine Intelligence Research Institute|2017-07|1255000|Support for general research";
    const id = generateId(input);
    expect(id).toBe("VvNfsbv6vA");
  });

  it("matches pinned value for an EA Funds-style grant", () => {
    const input = "ea-funds|yA12C1KcjQ|Redwood Research|2024-01|500000|Grant to Redwood Research";
    const id = generateId(input);
    expect(id).toBe("kPQNkZFIDW");
  });

  it("matches pinned value for an SFF-style grant", () => {
    const input = "sff|sIFjGbxVct|Machine Intelligence Research Institute|2023-01|1000000|Grant to Machine Intelligence Research Institute";
    const id = generateId(input);
    expect(id).toBe("fhjjtVfldI");
  });

  it("matches pinned value for an FTX-style grant", () => {
    const input = "ftx-future-fund|JhIGCaI3Ng|Redwood Research|2022-05|5000000|Grant to Redwood Research";
    const id = generateId(input);
    expect(id).toBe("hxc7JUIsP_");
  });

  it("matches pinned value for a Manifund-style grant", () => {
    const input = "manifund|fFVOuFZCRf|John Doe|2024-03-15|25000|AI Safety Research";
    const id = generateId(input);
    expect(id).toBe("dUvOGdlWPi");
  });
});
