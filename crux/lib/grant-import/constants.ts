/**
 * Entity stableIds for grant-making organizations.
 * These are looked up from data/entities/ YAML files.
 * To find or allocate new IDs: pnpm crux ids allocate <slug>
 */
export const FUNDER_IDS = {
  // Rebranded from Open Philanthropy to Coefficient Giving (November 2025)
  COEFFICIENT_GIVING: "ULjDXpSLCI",
  SFF: "sIFjGbxVct",
  FTX_FUTURE_FUND: "JhIGCaI3Ng",
  MANIFUND: "fFVOuFZCRf",
  LTFF: "yA12C1KcjQ",
  CEA: "gNsqAes7Dw",
} as const;
