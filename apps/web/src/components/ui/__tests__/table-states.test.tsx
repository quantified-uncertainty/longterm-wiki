/** @vitest-environment jsdom */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  TableLoadingRow,
  TableEmptyRow,
  TableErrorRow,
  TableSkeleton,
  TableEmptyBlock,
  TableErrorBlock,
  DEFAULT_LOADING_LABEL,
  DEFAULT_EMPTY_LABEL,
  DEFAULT_ERROR_LABEL,
} from "../table-states";

function renderInTable(node: React.ReactNode) {
  return render(
    <table>
      <tbody>{node}</tbody>
    </table>,
  );
}

describe("TableLoadingRow", () => {
  it("renders default loading label with status role and aria-busy", () => {
    renderInTable(<TableLoadingRow colSpan={5} />);
    const cell = screen.getByRole("status");
    expect(cell).toHaveTextContent(DEFAULT_LOADING_LABEL);
    expect(cell).toHaveAttribute("aria-busy", "true");
    expect(cell).toHaveAttribute("aria-live", "polite");
    expect(cell).toHaveAttribute("colspan", "5");
  });

  it("renders custom label when provided", () => {
    renderInTable(<TableLoadingRow colSpan={3} label="Loading organizations…" />);
    expect(screen.getByText("Loading organizations…")).toBeInTheDocument();
  });
});

describe("TableEmptyRow", () => {
  it("renders default empty message", () => {
    renderInTable(<TableEmptyRow colSpan={4} />);
    expect(screen.getByText(DEFAULT_EMPTY_LABEL)).toBeInTheDocument();
  });

  it("renders custom message and respects colSpan", () => {
    renderInTable(
      <TableEmptyRow colSpan={7} message="No organizations match your filters." />,
    );
    const cell = screen.getByText("No organizations match your filters.");
    expect(cell).toHaveAttribute("colspan", "7");
  });
});

describe("TableErrorRow", () => {
  it("renders error message from string with role=alert", () => {
    renderInTable(<TableErrorRow colSpan={3} error="API down" />);
    const cell = screen.getByRole("alert");
    expect(cell).toHaveTextContent("API down");
  });

  it("renders error message from Error instance", () => {
    renderInTable(<TableErrorRow colSpan={3} error={new Error("boom")} />);
    expect(screen.getByText("boom")).toBeInTheDocument();
  });

  it("falls back to default error label when error message is empty", () => {
    renderInTable(<TableErrorRow colSpan={3} error="" />);
    expect(screen.getByText(DEFAULT_ERROR_LABEL)).toBeInTheDocument();
  });
});

describe("TableSkeleton", () => {
  it("renders skeleton scaffold with provided dimensions and aria-busy", () => {
    const { container } = render(<TableSkeleton rows={3} columns={5} />);
    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("aria-busy", "true");
    // 3 body rows × 5 cells = 15 td, plus 5 th
    expect(container.querySelectorAll("th")).toHaveLength(5);
    expect(container.querySelectorAll("tbody tr")).toHaveLength(3);
    expect(container.querySelectorAll("tbody td")).toHaveLength(15);
  });

  it("includes screen-reader label", () => {
    render(<TableSkeleton label="Loading grants…" />);
    expect(screen.getByText("Loading grants…")).toBeInTheDocument();
  });
});

describe("TableEmptyBlock", () => {
  it("renders title and optional description", () => {
    render(
      <TableEmptyBlock
        title="No grants yet"
        description="Grants are populated during the build."
      />,
    );
    expect(screen.getByText("No grants yet")).toBeInTheDocument();
    expect(
      screen.getByText("Grants are populated during the build."),
    ).toBeInTheDocument();
  });

  it("renders an action element when provided", () => {
    render(
      <TableEmptyBlock title="Empty" action={<button type="button">Add one</button>} />,
    );
    expect(screen.getByRole("button", { name: "Add one" })).toBeInTheDocument();
  });
});

describe("TableErrorBlock", () => {
  it("renders error with role=alert", () => {
    render(<TableErrorBlock error="Server unavailable" />);
    expect(screen.getByRole("alert")).toHaveTextContent("Server unavailable");
  });

  it("renders retry button when retry handler is provided", () => {
    const retry = vi.fn();
    render(<TableErrorBlock error="boom" retry={retry} />);
    const btn = screen.getByRole("button", { name: /retry/i });
    btn.click();
    expect(retry).toHaveBeenCalledOnce();
  });
});
