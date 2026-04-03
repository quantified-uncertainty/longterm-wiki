/**
 * Mapping from Epoch AI benchmark CSV filenames to our benchmark slugs.
 *
 * Epoch publishes one CSV per benchmark. The filename (without .csv extension)
 * is the key. Our slugs are defined in data/entities/benchmarks.yaml.
 *
 * Files suffixed with "_external" are community-sourced data compiled by Epoch.
 * Files without the suffix are benchmarks Epoch runs themselves (higher quality,
 * standardized scoring).
 */

/**
 * Map of Epoch CSV filename (without .csv) to our benchmark slug.
 *
 * To add a new mapping: add the Epoch filename as key and the
 * slug from data/entities/benchmarks.yaml as value.
 */
export const EPOCH_FILENAME_TO_SLUG: Record<string, string> = {
  // ---- Epoch-run benchmarks (standardized, high quality) ----
  gpqa_diamond: "gpqa-diamond",
  math_level_5: "math-benchmark",
  swe_bench_verified: "swe-bench-verified",
  frontiermath: "frontiermath",
  frontiermath_tier_4: "frontiermath", // tier-4 subset maps to same benchmark
  simpleqa_verified: "simpleqa",
  chess_puzzles: "chess-puzzles", // not in our benchmark list yet — will be skipped
  otis_mock_aime_2024_2025: "aime-2025",

  // ---- External benchmarks ----
  mmlu_external: "mmlu",
  bbh_external: "bbh",
  hella_swag_external: "hellaswag",
  gsm8k_external: "gsm8k",
  arc_agi_external: "arc-agi",
  arc_agi_2_external: "arc-agi-2",
  os_world_external: "osworld",
  hle_external: "humanitys-last-exam",
  live_bench_external: "livebench",
  wino_grande_external: "winogrande",
  aider_polyglot_external: "aider-polyglot",
  arc_ai2_external: "arc-challenge",
  swe_bench_bash: "swe-bench-verified", // SWE-bench bash variant
  terminalbench_external: "terminal-bench-hard",
  weirdml_external: "weirdml", // not in our list yet
  cybench_external: "cybench", // not in our list yet
  simplebench_external: "simplebench", // not in our list yet
  webdev_arena_external: "webdev-arena", // not in our list yet
  metr_time_horizons_external: "metr-time-horizons", // not in our list yet
  deepresearchbench_external: "deepresearchbench", // not in our list yet
  video_mme_external: "video-mme", // not in our list yet
  the_agent_company_external: "the-agent-company", // not in our list yet
  gso_external: "gso", // not in our list yet
  posttrainbench_external: "posttrainbench", // not in our list yet
  apex_agents_external: "apex-agents", // not in our list yet
  balrog_external: "balrog", // not in our list yet
  cad_eval_external: "cad-eval", // not in our list yet

  // These external benchmarks map to our existing slugs:
  trivia_qa_external: "triviaqa", // not in our list yet
  piqa_external: "piqa", // not in our list yet
  open_book_qa_external: "openbookqa", // not in our list yet
  bool_q_external: "boolq", // not in our list yet
  lambada_external: "lambada", // not in our list yet
  science_qa_external: "scienceqa", // not in our list yet
  common_sense_qa_2_external: "commonsenseqa2", // not in our list yet
  superglue_external: "superglue", // not in our list yet
  adversarial_nli_external: "adversarial-nli", // not in our list yet
  fictionlivebench_external: "fictionlivebench", // not in our list yet
  geobench_external: "geobench", // not in our list yet
  gdpval_external: "gdpval", // not in our list yet
  vpct_external: "vpct", // not in our list yet
  lech_mazur_writing_external: "lech-mazur-writing", // not in our list yet

  // Skip the aggregate index — it's not a single benchmark
  // epoch_capabilities_index: null,
};

/**
 * Files to skip entirely (not individual benchmarks, or aggregate indices).
 */
export const EPOCH_SKIP_FILES = new Set([
  "epoch_capabilities_index",
  "README",
]);

/**
 * Get the source URL for a given Epoch benchmark.
 */
export function getEpochSourceUrl(filename: string): string {
  return `https://epoch.ai/data/benchmark_data.zip#${filename}.csv`;
}
