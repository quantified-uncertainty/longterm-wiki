/**
 * Inline sourcing schema — re-exports from `api-types.ts`.
 *
 * The canonical definition lives in `api-types.ts` (so it can be safely
 * bundled by `apps/web/` without webpack hitting a deep `.js` relative-path
 * resolution failure). Route files keep importing from this path because it
 * was the historical home of the schema; renaming every import is not
 * worth the churn.
 */

export {
  InlineSourcingSchema,
  type InlineSourcing,
} from "../../api-types.js";
