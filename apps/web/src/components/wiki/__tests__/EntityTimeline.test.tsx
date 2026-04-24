// @vitest-environment jsdom
/**
 * Tests for EntityTimeline — covers sort order, column auto-detection,
 * filtering, empty state, and source rendering.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { EntityEvent } from "@data/factbase";

const mockGetEntityEvents = vi.fn<(entityId: string) => EntityEvent[]>();

vi.mock("@data/factbase", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@data/factbase")>();
  return {
    ...actual,
    getEntityEvents: (id: string) => mockGetEntityEvents(id),
  };
});

import { EntityTimeline } from "../EntityTimeline";

function makeEvent(overrides: Partial<EntityEvent>): EntityEvent {
  return {
    id: "ev1",
    entityId: "sid_test000001",
    title: "Untitled event",
    ...overrides,
  };
}

describe("EntityTimeline", () => {
  it("renders nothing when there are no events", () => {
    mockGetEntityEvents.mockReturnValueOnce([]);
    const { container } = render(<EntityTimeline entity="orphan" />);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when no entity and no events prop provided", () => {
    const { container } = render(<EntityTimeline />);
    expect(container.firstChild).toBeNull();
  });

  it("renders rows from getEntityEvents when entity prop is given", () => {
    mockGetEntityEvents.mockReturnValueOnce([
      makeEvent({ id: "a", title: "Founded", date: "2020" }),
      makeEvent({ id: "b", title: "Launched", date: "2021" }),
    ]);
    render(<EntityTimeline entity="example-org" />);
    expect(mockGetEntityEvents).toHaveBeenCalledWith("example-org");
    expect(screen.getByText("Founded")).toBeInTheDocument();
    expect(screen.getByText("Launched")).toBeInTheDocument();
  });

  it("sorts events ascending by date by default (oldest first)", () => {
    const events: EntityEvent[] = [
      makeEvent({ id: "c", title: "Third", date: "2023" }),
      makeEvent({ id: "a", title: "First", date: "2020" }),
      makeEvent({ id: "b", title: "Second", date: "2021-06" }),
    ];
    render(<EntityTimeline events={events} />);
    const titles = screen.getAllByRole("row").slice(1).map(
      (r) => r.querySelectorAll("td")[1]?.textContent,
    );
    expect(titles).toEqual(["First", "Second", "Third"]);
  });

  it("sorts descending when sort='desc' is passed", () => {
    const events: EntityEvent[] = [
      makeEvent({ id: "a", title: "First", date: "2020" }),
      makeEvent({ id: "c", title: "Third", date: "2023" }),
      makeEvent({ id: "b", title: "Second", date: "2021-06" }),
    ];
    render(<EntityTimeline events={events} sort="desc" />);
    const titles = screen.getAllByRole("row").slice(1).map(
      (r) => r.querySelectorAll("td")[1]?.textContent,
    );
    expect(titles).toEqual(["Third", "Second", "First"]);
  });

  it("places events with missing dates at the end of ascending sort", () => {
    const events: EntityEvent[] = [
      makeEvent({ id: "c", title: "No date" }),
      makeEvent({ id: "a", title: "Earliest", date: "2020" }),
      makeEvent({ id: "b", title: "Later", date: "2021" }),
    ];
    render(<EntityTimeline events={events} />);
    const titles = screen.getAllByRole("row").slice(1).map(
      (r) => r.querySelectorAll("td")[1]?.textContent,
    );
    expect(titles).toEqual(["Earliest", "Later", "No date"]);
  });

  it("auto-hides the Type column when no event has eventType", () => {
    const events: EntityEvent[] = [
      makeEvent({ title: "Plain", date: "2020" }),
    ];
    render(<EntityTimeline events={events} />);
    expect(screen.queryByText("Type")).not.toBeInTheDocument();
  });

  it("auto-shows the Type column when any event has eventType", () => {
    const events: EntityEvent[] = [
      makeEvent({ id: "a", title: "Product debut", date: "2021", eventType: "launch" }),
      makeEvent({ id: "b", title: "Other", date: "2022" }),
    ];
    render(<EntityTimeline events={events} />);
    expect(screen.getByText("Type")).toBeInTheDocument();
    // Title text and type badge text don't collide
    expect(screen.getByText("Launch")).toBeInTheDocument();
    expect(screen.getByText("Product debut")).toBeInTheDocument();
  });

  it("hides the Significance column by default even when data is present", () => {
    const events: EntityEvent[] = [
      makeEvent({ title: "X", date: "2020", significance: "major" }),
    ];
    render(<EntityTimeline events={events} />);
    expect(screen.queryByText("Significance")).not.toBeInTheDocument();
  });

  it("renders Significance column with colored badge when opt-in", () => {
    const events: EntityEvent[] = [
      makeEvent({ id: "a", title: "X", date: "2020", significance: "major" }),
      makeEvent({ id: "b", title: "Y", date: "2021", significance: "minor" }),
    ];
    render(<EntityTimeline events={events} showSignificance />);
    expect(screen.getByText("Significance")).toBeInTheDocument();
    expect(screen.getByText("Major")).toBeInTheDocument();
    expect(screen.getByText("Minor")).toBeInTheDocument();
  });

  it("filters to a specific eventType when provided", () => {
    const events: EntityEvent[] = [
      makeEvent({ id: "a", title: "Founded", date: "2020", eventType: "founding" }),
      makeEvent({ id: "b", title: "Pivoted", date: "2022", eventType: "pivot" }),
      makeEvent({ id: "c", title: "Funded", date: "2023", eventType: "funding" }),
    ];
    render(<EntityTimeline events={events} eventType="funding" />);
    expect(screen.getByText("Funded")).toBeInTheDocument();
    expect(screen.queryByText("Founded")).not.toBeInTheDocument();
    expect(screen.queryByText("Pivoted")).not.toBeInTheDocument();
  });

  it("renders nothing when eventType filter produces no matches", () => {
    const events: EntityEvent[] = [
      makeEvent({ title: "Founded", date: "2020", eventType: "founding" }),
    ];
    const { container } = render(
      <EntityTimeline events={events} eventType="acquisition" />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("auto-detects columns from the full sorted set, not the post-maxItems slice", () => {
    // Only the last (newest) event has a source URL. In desc sort it lands at
    // row 0. With maxItems=2 in asc sort it would be clipped; the Source column
    // still needs to render for the visible rows that carry that data — but
    // conversely, source data that lives only in the *excluded* tail must
    // still be reflected in header detection so the column renders where
    // applicable. This test locks that the detector reads all sorted rows.
    const events: EntityEvent[] = [
      makeEvent({ id: "a", title: "A", date: "2020" }),
      makeEvent({ id: "b", title: "B", date: "2021" }),
      makeEvent({ id: "c", title: "C", date: "2022" }),
      makeEvent({
        id: "d",
        title: "D",
        date: "2023",
        source: "https://example.com/source",
      }),
    ];
    render(<EntityTimeline events={events} maxItems={2} />);
    expect(screen.getByText("Source")).toBeInTheDocument();
  });

  it("caps rows to maxItems (respecting the sorted order)", () => {
    const events: EntityEvent[] = [
      makeEvent({ id: "a", title: "2020-event", date: "2020" }),
      makeEvent({ id: "b", title: "2021-event", date: "2021" }),
      makeEvent({ id: "c", title: "2022-event", date: "2022" }),
      makeEvent({ id: "d", title: "2023-event", date: "2023" }),
    ];
    render(<EntityTimeline events={events} sort="desc" maxItems={2} />);
    expect(screen.getByText("2023-event")).toBeInTheDocument();
    expect(screen.getByText("2022-event")).toBeInTheDocument();
    expect(screen.queryByText("2021-event")).not.toBeInTheDocument();
    expect(screen.queryByText("2020-event")).not.toBeInTheDocument();
  });

  it("renders Source as a short-domain external link when URL is present", () => {
    const events: EntityEvent[] = [
      makeEvent({
        title: "Paper",
        date: "2024",
        source: "https://arxiv.org/abs/2401.12345",
      }),
    ];
    render(<EntityTimeline events={events} />);
    const link = screen.getByRole("link");
    expect(link).toHaveAttribute("href", "https://arxiv.org/abs/2401.12345");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", expect.stringContaining("noopener"));
    expect(link).toHaveTextContent("arxiv.org");
  });

  it("hides Source column when no event has a URL source", () => {
    const events: EntityEvent[] = [
      makeEvent({ title: "X", date: "2020", source: "Internal note" }),
    ];
    render(<EntityTimeline events={events} />);
    expect(screen.queryByText("Source")).not.toBeInTheDocument();
  });

  it("renders the optional title heading", () => {
    const events: EntityEvent[] = [makeEvent({ title: "X", date: "2020" })];
    render(<EntityTimeline events={events} title="Timeline" />);
    expect(
      screen.getByRole("heading", { name: "Timeline" }),
    ).toBeInTheDocument();
  });

  it("does not render a heading when title prop is omitted", () => {
    const events: EntityEvent[] = [makeEvent({ title: "X", date: "2020" })];
    render(<EntityTimeline events={events} />);
    expect(screen.queryByRole("heading")).not.toBeInTheDocument();
  });

  it("renders an em-dash placeholder for events missing a date", () => {
    const events: EntityEvent[] = [
      makeEvent({ title: "Undated event" }),
    ];
    render(<EntityTimeline events={events} />);
    expect(screen.getByText("\u2014")).toBeInTheDocument();
  });
});
