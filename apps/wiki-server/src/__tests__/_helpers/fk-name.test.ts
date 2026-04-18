import { describe, it, expect } from "vitest";
import { expectedFkName } from "./fk-name.js";

describe("expectedFkName", () => {
  it("joins the four components with underscores and appends _fk", () => {
    expect(expectedFkName("orders", "customer_id", "customers", "id")).toBe(
      "orders_customer_id_customers_id_fk",
    );
  });

  it("matches the real Drizzle name for resource_citations FK post-QUA-566", () => {
    // The exact string that migration 0192 produces; regression anchor for
    // the Drizzle naming convention encoded in this helper.
    expect(
      expectedFkName("resource_citations", "resource_id", "resources", "stable_id"),
    ).toBe("resource_citations_resource_id_resources_stable_id_fk");
  });

  it("preserves snake_case in multi-word column names", () => {
    expect(expectedFkName("a", "multi_part_col", "b", "other_col")).toBe(
      "a_multi_part_col_b_other_col_fk",
    );
  });
});
