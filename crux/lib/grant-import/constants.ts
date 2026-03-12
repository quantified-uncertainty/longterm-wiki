/**
 * Entity stableIds for grant-making organizations.
 * These are looked up from data/entities/ YAML files.
 * To find or allocate new IDs: pnpm crux ids allocate <slug>
 */
export const FUNDER_IDS = {
  OPEN_PHILANTHROPY: "ULjDXpSLCI",
  SFF: "sIFjGbxVct",
  FTX_FUTURE_FUND: "JhIGCaI3Ng",
  MANIFUND: "fFVOuFZCRf",
  LTFF: "yA12C1KcjQ",
  CEA: "gNsqAes7Dw",
  // TODO: GiveWell and ACX Grants don't have entity pages yet.
  // Allocate stableIds with `pnpm crux ids allocate givewell` and
  // `pnpm crux ids allocate acx-grants` once entity YAML files are created.
  GIVEWELL: "NEEDS_ALLOCATION",
  ACX_GRANTS: "NEEDS_ALLOCATION",
} as const;
