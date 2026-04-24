import { describe, expect, it } from "vitest";
import {
  extractPrNumber,
  hasStageApproved,
  unresolvedMajorBotCount,
} from "./check-pr-merge-eligible.ts";

describe("extractPrNumber", () => {
  it("recognises plain `gh pr merge 1234`", () => {
    expect(extractPrNumber("gh pr merge 1234")).toBe(1234);
  });

  it("recognises flags before the number", () => {
    expect(extractPrNumber("gh pr merge --auto --squash 1234")).toBe(1234);
    expect(extractPrNumber("gh pr merge -R owner/repo 4576")).toBe(4576);
  });

  it("recognises owner/repo#1234 form", () => {
    expect(
      extractPrNumber("gh pr merge quantified-uncertainty/longterm-wiki#4576"),
    ).toBe(4576);
  });

  it("recognises a github.com pull URL", () => {
    expect(
      extractPrNumber(
        "gh pr merge https://github.com/quantified-uncertainty/longterm-wiki/pull/4576",
      ),
    ).toBe(4576);
  });

  it("recognises pnpm/npx prefixes", () => {
    expect(extractPrNumber("pnpm gh pr merge 100")).toBe(100);
  });

  it("returns null when only a branch selector is given", () => {
    expect(extractPrNumber("gh pr merge my-feature-branch --auto")).toBeNull();
  });

  it("returns null when the command is unrelated", () => {
    expect(extractPrNumber("gh pr view 1234")).toBeNull();
    expect(extractPrNumber("echo hello")).toBeNull();
  });
});

describe("hasStageApproved", () => {
  it("true when stage:approved is in the labels", () => {
    expect(
      hasStageApproved({
        labels: { nodes: [{ name: "bug" }, { name: "stage:approved" }] },
        reviewThreads: { nodes: [] },
      }),
    ).toBe(true);
  });

  it("false when stage:approved is missing", () => {
    expect(
      hasStageApproved({
        labels: { nodes: [{ name: "bug" }, { name: "pr-patrol:working" }] },
        reviewThreads: { nodes: [] },
      }),
    ).toBe(false);
  });

  it("false on an empty label set", () => {
    expect(
      hasStageApproved({
        labels: { nodes: [] },
        reviewThreads: { nodes: [] },
      }),
    ).toBe(false);
  });
});

describe("unresolvedMajorBotCount", () => {
  const thread = (
    isResolved: boolean,
    body: string,
    login = "coderabbitai",
  ) => ({
    isResolved,
    comments: { nodes: [{ author: { login }, body }] },
  });

  it("counts unresolved Major/Critical/Potential-issue threads", () => {
    expect(
      unresolvedMajorBotCount({
        labels: { nodes: [] },
        reviewThreads: {
          nodes: [
            thread(false, "Potential issue | 🟠 Major\nfoo"),
            thread(false, "Critical: do this"),
            thread(false, "Just a Minor nit"),
          ],
        },
      }),
    ).toBe(2);
  });

  it("ignores resolved threads even if they match severity", () => {
    expect(
      unresolvedMajorBotCount({
        labels: { nodes: [] },
        reviewThreads: {
          nodes: [thread(true, "Major: do this"), thread(false, "Major: fix")],
        },
      }),
    ).toBe(1);
  });

  it("ignores non-CodeRabbit authors", () => {
    expect(
      unresolvedMajorBotCount({
        labels: { nodes: [] },
        reviewThreads: {
          nodes: [thread(false, "Critical: foo", "github-actions")],
        },
      }),
    ).toBe(0);
  });

  it("handles author=null gracefully", () => {
    expect(
      unresolvedMajorBotCount({
        labels: { nodes: [] },
        reviewThreads: {
          nodes: [
            {
              isResolved: false,
              comments: { nodes: [{ author: null, body: "Major: x" }] },
            },
          ],
        },
      }),
    ).toBe(0);
  });

  it("returns 0 when there are no threads", () => {
    expect(
      unresolvedMajorBotCount({
        labels: { nodes: [] },
        reviewThreads: { nodes: [] },
      }),
    ).toBe(0);
  });
});
