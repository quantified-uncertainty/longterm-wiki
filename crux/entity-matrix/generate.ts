#!/usr/bin/env node
/**
 * Entity Matrix — JSON Generator
 *
 * Runs the scanner and writes entity-matrix.json to the app data directory.
 * Called during build-data to make the matrix available at render time.
 *
 * Usage:
 *   node --import tsx/esm crux/entity-matrix/generate.ts
 */

import { writeFileSync } from "fs";
import { join } from "path";
import { PROJECT_ROOT } from "../lib/content-types.ts";
import { scanMatrix } from "./scanner.ts";

const OUTPUT_PATH = join(
  PROJECT_ROOT,
  "apps/web/src/data/entity-matrix.json",
);

console.log("  entity-matrix: scanning...");
const snapshot = scanMatrix();
writeFileSync(OUTPUT_PATH, JSON.stringify(snapshot));
console.log(
  `  entity-matrix: ${snapshot.rows.length} types × ${snapshot.dimensions.length} dims → entity-matrix.json (${snapshot.overallScore}% overall)`,
);
