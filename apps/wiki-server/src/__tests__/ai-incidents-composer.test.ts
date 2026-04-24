/**
 * Unit tests for the ai_incident composer registered in
 * apps/wiki-server/src/routes/tablebase/ai-incidents.ts.
 *
 * The composer is the pure function that maps an incident row + entity
 * title map to {title, description, parentTitle} for the things sync
 * dual-write. Pure → no mocks required.
 *
 * Heavier integration tests covering the route's GET endpoints + the
 * postUpsert reports replace-all behavior are tracked separately
 * (see QUA-693 PR description for follow-up ticket).
 */

import { describe, it, expect, beforeAll } from "vitest";
import {
  composeThing,
  hasComposer,
} from "../routes/shared/compose-thing.js";

beforeAll(async () => {
  // Side-effect import: registers the "ai_incident" composer.
  await import("../routes/tablebase/ai-incidents.js");
});

interface AiIncidentComposerRow {
  title: string;
  summary: string;
  orgId?: string | null;
  developerOrgId?: string | null;
  aiModelId?: string | null;
}

describe("ai_incident composer", () => {
  it("registers under the 'ai_incident' thing_type", () => {
    expect(hasComposer("ai_incident")).toBe(true);
  });

  it("uses the title verbatim", () => {
    const out = composeThing<AiIncidentComposerRow>(
      "ai_incident",
      { title: "Chatbot leaked PII", summary: "short summary" },
      new Map(),
    );
    expect(out.title).toBe("Chatbot leaked PII");
  });

  it("returns the full summary as description when ≤300 chars", () => {
    const summary = "a".repeat(280);
    const out = composeThing<AiIncidentComposerRow>(
      "ai_incident",
      { title: "T", summary },
      new Map(),
    );
    expect(out.description).toBe(summary);
  });

  it("truncates description to 297 + '...' when >300 chars", () => {
    const summary = "a".repeat(500);
    const out = composeThing<AiIncidentComposerRow>(
      "ai_incident",
      { title: "T", summary },
      new Map(),
    );
    expect(out.description).toHaveLength(300);
    expect(out.description!.endsWith("...")).toBe(true);
  });

  it("prefers orgId for parentTitle when present and resolvable", () => {
    const out = composeThing<AiIncidentComposerRow>(
      "ai_incident",
      {
        title: "T",
        summary: "S",
        orgId: "sid_acme00001",
        developerOrgId: "sid_widgetlab",
        aiModelId: "sid_modelxxxx",
      },
      new Map([
        ["sid_acme00001", "Acme Corp"],
        ["sid_widgetlab", "Widget Labs"],
        ["sid_modelxxxx", "WidgetGPT-1"],
      ]),
    );
    expect(out.parentTitle).toBe("Acme Corp");
  });

  it("falls back to developerOrgId when orgId is unresolved", () => {
    const out = composeThing<AiIncidentComposerRow>(
      "ai_incident",
      {
        title: "T",
        summary: "S",
        orgId: "sid_unknown000",
        developerOrgId: "sid_widgetlab",
      },
      new Map([["sid_widgetlab", "Widget Labs"]]),
    );
    expect(out.parentTitle).toBe("Widget Labs");
  });

  it("falls back to aiModelId when org and developer are unresolved", () => {
    const out = composeThing<AiIncidentComposerRow>(
      "ai_incident",
      {
        title: "T",
        summary: "S",
        aiModelId: "sid_modelxxxx",
      },
      new Map([["sid_modelxxxx", "WidgetGPT-1"]]),
    );
    expect(out.parentTitle).toBe("WidgetGPT-1");
  });

  it("returns null parentTitle when no attribution at all", () => {
    const out = composeThing<AiIncidentComposerRow>(
      "ai_incident",
      { title: "T", summary: "S" },
      new Map(),
    );
    expect(out.parentTitle).toBeNull();
  });

  it("returns null parentTitle when all attributed IDs are unresolved", () => {
    const out = composeThing<AiIncidentComposerRow>(
      "ai_incident",
      {
        title: "T",
        summary: "S",
        orgId: "sid_unknown001",
        developerOrgId: "sid_unknown002",
        aiModelId: "sid_unknown003",
      },
      new Map(),
    );
    expect(out.parentTitle).toBeNull();
  });
});
