/**
 * Entity stableIds for grant-making organizations.
 * These are looked up from data/entities/ YAML files.
 * To find or allocate new IDs: pnpm crux ids allocate <slug>
 *
 * This is the single canonical source for org entity IDs used across
 * grant imports, division imports, and funding program imports.
 */
export const FUNDER_IDS = {
  OPEN_PHILANTHROPY: "sid_ULjDXpSLCI",
  // Coefficient Giving is Open Philanthropy's grantmaking arm — same entity
  COEFFICIENT_GIVING: "sid_ULjDXpSLCI",
  // Was "sIFjGbxVct" (old FactBase ID); fixed by migration 0104_fix_stale_entity_ids.
  SFF: "sid_pvJ50HupEQ",
  FTX_FUTURE_FUND: "sid_JhIGCaI3Ng",
  MANIFUND: "sid_fFVOuFZCRf",
  LTFF: "sid_yA12C1KcjQ",
  CEA: "sid_gNsqAes7Dw",
  GIVEWELL: "sid_OwXl35e7bg",
  ACX_GRANTS: "sid_LBr3ocKKyQ",
  FLI: "sid_d9sWZtyVwg",
  SCHMIDT_FUTURES: "sid_h6ntSGk8fg",
  GATES_FOUNDATION: "sid_l4EHdNDZqg",
  GOOD_VENTURES: "sid_hQ4Rdnaihw",
  WELLCOME_TRUST: "sid_D3QcAF9wzQ",
  ROCKEFELLER_FOUNDATION: "sid_3wtyeezoxQ",
  FORD_FOUNDATION: "sid_3ViojCH3Sw",
  BLOOMBERG_PHILANTHROPIES: "sid_H9mGnBuumA",
  ARNOLD_VENTURES: "sid_AT0VDnvwRw",
  OMIDYAR_NETWORK: "sid_GADd9PU0UA",
  SKOLL_FOUNDATION: "sid_3swyqpXTRA",
  ACE: "sid_nJF5vuz1kA",
  TEMPLETON_FOUNDATION: "sid_W3UAlnscAg",
  CIFF: "sid_Z6vKggPBaA",
  BEZOS_EARTH_FUND: "sid_fVMqY7vpMA",
  ARIA: "sid_XqjV4mbMXQ",
  // --- Added for Vipul Naik multi-donor import ---
  HEWLETT_FOUNDATION: "sid_9nUCGERzgQ",
  MACARTHUR_FOUNDATION: "sid_8q2GhtEmkA",
  CHAN_ZUCKERBERG_INITIATIVE: "sid_rYERluiUwH",
  FOUNDERS_PLEDGE: "sid_TBgnF576Vg",
  SLOAN_FOUNDATION: "sid_lI8DgWtPyD",
  THIEL_FOUNDATION: "sid_0SkH1jbTRu",
  KNIGHT_FOUNDATION: "sid_BAGFs8P6WP",
  KELLOGG_FOUNDATION: "sid_1SqvvamQqq",
  PINEAPPLE_FUND: "sid_wTnEjSfIeP",
  GOOGLE_ORG: "sid_J2DYTkMiRA",
  LILLY_ENDOWMENT: "sid_kxVSuuHN7j",
  MELLON_FOUNDATION: "sid_MIie9_9BSq",
  WALTON_FAMILY_FOUNDATION: "sid_gk4_-AGcTd",
  WALLENBERG_FOUNDATION: "sid_G7eigma43U",
  BARR_FOUNDATION: "sid_RfxfdsVA3R",
  SANDLER_FOUNDATION: "sid_EPY-YnX6K8",
  SURDNA_FOUNDATION: "sid_6wJ85FrPfi",
  DONORSTRUST: "sid_rY6Rdleg5f",
  VITALIK_BUTERIN: "sid_iEEm0cZ3tn",
  FORESIGHT_INSTITUTE: "sid_NPPTvNqRXA",
} as const;

/**
 * Superset of FUNDER_IDS that also includes non-funder organizations
 * referenced by divisions and funding programs (e.g., AI labs).
 */
export const ORG_IDS = {
  ...FUNDER_IDS,
  ANTHROPIC: "sid_mK9pX3rQ7n",
  OPENAI: "sid_1LcLlMGLbw",
  DEEPMIND: "sid_A4XoubikkQ",
  MIRI: "sid_puAffUjWSS",
  RAND: "sid_8grDoD8kig",
  ARC: "sid_QsXVXtQ0zE",
  REDWOOD_RESEARCH: "sid_dwMzc9WzPa",
  CHAI: "sid_zMfgJqiEPQ",
  CAIS: "sid_y4bieqSeag",
  GOVAI: "sid_XLLyzaEaCA",
  CSET: "sid_lvsDuyzPcg",
  EPOCH_AI: "sid_cBPkzcVBBQ",
  APOLLO_RESEARCH: "sid_pKeaWwP6sQ",
} as const;
