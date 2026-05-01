/**
 * Type-level test for the `validationError` overload (QUA-951).
 *
 * The overload's stated purpose is to preserve Hono RPC inference. The string
 * overload should expose its 400 body as `{ error: "validation_error";
 * message: string }`, and the structured overload should expose
 * `{ error: "validation_error" } & ValidationErrorBody` (with
 * `JSONParsed<...>` applied by Hono).
 *
 * If a future refactor (e.g. swapping the overloads back to a bare `Response`
 * return type) breaks RPC inference, this file should fail to compile —
 * surfacing the regression at PR-time instead of silently degrading
 * `InferResponseType<...>` for every consumer of `api-response-types.ts`.
 *
 * Run via: `pnpm tsc --noEmit -p apps/wiki-server/tsconfig.json`
 */

import { Hono } from "hono";
import type { InferResponseType } from "hono/client";
import { hc } from "hono/client";
import { validationError } from "./utils.js";

// ---------------------------------------------------------------------------
// String-overload route
// ---------------------------------------------------------------------------

const stringApp = new Hono().get("/x", (c) =>
  validationError(c, "bad input"),
);

type StringRpc = ReturnType<typeof hc<typeof stringApp>>;
type StringErr = InferResponseType<StringRpc["x"]["$get"], 400>;

// String overload's 400 body must expose `error` and `message` fields.
// If the return type ever degrades to bare `Response`, both assignments fail.
const _stringErr: { error: "validation_error"; message: string } =
  null as unknown as StringErr; // as-any-ok: type-level RPC inference assertion
const _stringErrReverse: StringErr = {
  error: "validation_error",
  message: "x",
};

// ---------------------------------------------------------------------------
// Structured-body-overload route
// ---------------------------------------------------------------------------

const bodyApp = new Hono().get("/x", (c) =>
  validationError(c, {
    code: "fk_missing",
    message: "missing",
    field: "personId",
    value: "sid_unknown",
  }),
);

type BodyRpc = ReturnType<typeof hc<typeof bodyApp>>;
type BodyErr = InferResponseType<BodyRpc["x"]["$get"], 400>;

// Structured-body-overload's 400 body exposes the documented optional fields.
// `JSONParsed<...>` widens `value?: unknown` to a JSON-compatible shape, so
// we pin only the keys we care about and let Hono's parser widen the rest.
const _bodyErr: BodyErr = {
  error: "validation_error",
  code: "fk_missing",
  message: "missing",
  field: "personId",
  value: "sid_unknown",
};

// `code` must be present in the inferred shape — if it ever vanishes the
// canary dual-write callers lose their structural discriminator.
type CodePresent = "code" extends keyof BodyErr ? true : false;
const _codePresent: CodePresent = true;

// `error` must be the literal `"validation_error"`, not widened to `string`.
type ErrorIsLiteral = BodyErr["error"] extends "validation_error" ? true : false;
const _errorIsLiteral: ErrorIsLiteral = true;
