/**
 * Entity stableIds for grant-making organizations.
 * These are looked up from data/entities/ YAML files.
 * To find or allocate new IDs: pnpm crux ids allocate <slug>
 *
 * This is the single canonical source for org entity IDs used across
 * grant imports, division imports, and funding program imports.
 */
export const FUNDER_IDS = {
  OPEN_PHILANTHROPY: "ULjDXpSLCI",
  // Coefficient Giving is Open Philanthropy's grantmaking arm — same entity
  COEFFICIENT_GIVING: "ULjDXpSLCI",
  SFF: "sIFjGbxVct",
  FTX_FUTURE_FUND: "JhIGCaI3Ng",
  MANIFUND: "fFVOuFZCRf",
  LTFF: "yA12C1KcjQ",
  CEA: "gNsqAes7Dw",
  GIVEWELL: "OwXl35e7bg",
  ACX_GRANTS: "LBr3ocKKyQ",
  FLI: "d9sWZtyVwg",
  SCHMIDT_FUTURES: "h6ntSGk8fg",
} as const;

/**
 * Superset of FUNDER_IDS that also includes non-funder organizations
 * referenced by divisions and funding programs (e.g., AI labs).
 */
export const ORG_IDS = {
  ...FUNDER_IDS,
  ANTHROPIC: "mK9pX3rQ7n",
  OPENAI: "1LcLlMGLbw",
  DEEPMIND: "A4XoubikkQ",
  MIRI: "puAffUjWSS",
} as const;
