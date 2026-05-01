import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { validationError, type ValidationErrorBody } from "../routes/shared/utils.js";

/**
 * QUA-951: validationError now exposes two overloads — a legacy string form
 * and a structured-body form. Both must produce a 400 with the same
 * `error: "validation_error"` envelope; the structured form carries an
 * additional `code` discriminator plus optional context fields so canary
 * dual-write callers can branch on `code` instead of pattern-matching the
 * message string.
 */

describe("validationError", () => {
  it("string overload returns 400 with the legacy envelope", async () => {
    const app = new Hono().get("/x", (c) => validationError(c, "bad input"));
    const res = await app.request("/x");

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "validation_error",
      message: "bad input",
    });
  });

  it("body overload returns 400 with the structured envelope", async () => {
    const app = new Hono().get("/x", (c) =>
      validationError(c, {
        code: "fk_missing",
        message: "entity not found",
        field: "personId",
        value: "sid_unknown",
      })
    );
    const res = await app.request("/x");

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "validation_error",
      code: "fk_missing",
      message: "entity not found",
      field: "personId",
      value: "sid_unknown",
    });
  });

  it("body overload omits unset optional fields", async () => {
    const app = new Hono().get("/x", (c) =>
      validationError(c, { code: "zod", message: "schema failed" })
    );
    const res = await app.request("/x");
    const body = await res.json();

    expect(body).toEqual({
      error: "validation_error",
      code: "zod",
      message: "schema failed",
    });
    expect(body).not.toHaveProperty("field");
    expect(body).not.toHaveProperty("value");
    expect(body).not.toHaveProperty("allowed");
    expect(body).not.toHaveProperty("similar");
  });

  it("body overload carries allowed[] and similar[] when provided", async () => {
    const app = new Hono().get("/x", (c) =>
      validationError(c, {
        code: "enum_violation",
        message: "invalid status",
        field: "status",
        value: "actiev",
        allowed: ["active", "pending", "archived"],
        similar: ["active"],
      })
    );
    const res = await app.request("/x");

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "validation_error",
      code: "enum_violation",
      message: "invalid status",
      field: "status",
      value: "actiev",
      allowed: ["active", "pending", "archived"],
      similar: ["active"],
    });
  });

  it("both overloads produce the same envelope shape and status (additive contract)", async () => {
    const stringApp = new Hono().get("/x", (c) =>
      validationError(c, "natural key collision")
    );
    const bodyApp = new Hono().get("/x", (c) =>
      validationError(c, {
        code: "natural_key",
        message: "natural key collision",
      })
    );

    const stringRes = await stringApp.request("/x");
    const bodyRes = await bodyApp.request("/x");

    expect(stringRes.status).toBe(bodyRes.status);
    expect(stringRes.status).toBe(400);

    const stringBody = await stringRes.json();
    const bodyBody = await bodyRes.json();

    expect(stringBody.error).toBe("validation_error");
    expect(bodyBody.error).toBe("validation_error");
    expect(stringBody.message).toBe(bodyBody.message);
  });

  it("body overload accepts open-ended code strings (forward compat)", async () => {
    const future: ValidationErrorBody = {
      code: "some_future_code",
      message: "future shape",
    };
    const app = new Hono().get("/x", (c) => validationError(c, future));
    const res = await app.request("/x");

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "validation_error",
      code: "some_future_code",
      message: "future shape",
    });
  });
});
