import { describe, it, expect } from "vitest";
import { commands } from "./third-party-evals.ts";

describe("third-party-evals CLI dispatcher", () => {
  it("default command shows help when no verb given", async () => {
    const r = await commands.default([], {});
    expect(r.exitCode).toBe(0);
    expect(r.output).toContain("Third-Party Evaluations");
  });

  it("default command rejects unknown verb", async () => {
    const r = await commands.default(["bogus"], {});
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("Unknown subcommand 'bogus'");
  });

  it("ingest requires evaluator name", async () => {
    const r = await commands.ingest([], {});
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("Usage:");
  });

  it("ingest rejects unknown evaluator name", async () => {
    const r = await commands.ingest(["orange-aisi"], {});
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("Unknown evaluator");
  });

  it("extract requires url", async () => {
    const r = await commands.extract([], {});
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("Usage:");
  });

  it("extract requires --evaluator flag", async () => {
    const r = await commands.extract(["https://aisi.gov.uk/blog/foo"], {});
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("--evaluator=");
  });

  it("default routes to ingest on 'ingest' verb", async () => {
    const r = await commands.default(["ingest"], {});
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("Usage: crux tb third-party-evals ingest");
  });

  it("default routes to extract on 'extract' verb", async () => {
    const r = await commands.default(["extract"], {});
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("Usage: crux tb third-party-evals extract");
  });

  it("backfill requires evaluator name", async () => {
    const r = await commands.backfill([], {});
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("Usage: crux tb third-party-evals backfill");
  });

  it("backfill requires --evaluator flag", async () => {
    const r = await commands.backfill(["uk-aisi"], {});
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("--evaluator=");
  });

  it("default routes to backfill on 'backfill' verb", async () => {
    const r = await commands.default(["backfill"], {});
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain("Usage: crux tb third-party-evals backfill");
  });

  it("default rejects unknown verb with new error message", async () => {
    const r = await commands.default(["bogus"], {});
    expect(r.exitCode).toBe(1);
    // mentions all three valid verbs
    expect(r.output).toMatch(/ingest.*extract.*backfill/);
  });
});
