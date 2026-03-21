/**
 * Output File Writer
 *
 * Writes the final JSON output files for the build: database.json,
 * factbase-data.json, individual data files, derived data files,
 * per-entity JSON bundles, and link health data.
 *
 * Extracted from build-data.mjs for modularity.
 */

import { writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { OUTPUT_DIR } from './content-types.mjs';

/**
 * Write the main database.json and factbase-data.json output files.
 *
 * @param {object} opts
 * @param {object} opts.database - The full database object
 * @param {string} opts.outputFile - Path to database.json
 * @returns {{ databaseForOutput: object, kbData: object|null, strippedFields: object }}
 */
export function writeMainOutputFiles({ database, outputFile }) {
  // Ensure output directory exists
  if (!existsSync(OUTPUT_DIR)) {
    mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  // Write combined JSON — strip fields that aren't needed in the rendering cache:
  // - Raw entities, KB data, experts: only typedEntities needed at runtime
  // - Wiki-server-sourced fields: served from PG at runtime or via per-entity bundles
  // - Operational data: prItems (build-only), redundancyPairs (dashboard-only)
  const {
    entities: _rawEntities,
    kb: _kbData,
    experts: _experts,
    // Phase 1: Wiki-server-sourced data (served from PG at runtime)
    benchmarkResults: _benchmarkResults,
    citationQuotes: _citationQuotes,
    recordVerdicts: _recordVerdicts,
    kbFactVerification: _kbFactVerification,
    researchAreas: _researchAreas,
    pageReferenceIndex: _pageReferenceIndex,
    // Phase 2: Operational/internal-only data (dashboards use wiki-server API)
    prItems: _prItems,
    updateSchedule: _updateSchedule,
    redundancyPairs: _redundancyPairs,
    // Phase 3: Relational data (already in per-entity bundles)
    backlinks: _backlinks,
    relatedGraph: _relatedGraph,
    // Phase 4: Large arrays moved to separate lazy-loaded files
    resources: _resources,
    ...databaseForOutput
  } = database;

  // Strip dashboard-only fields from pages to reduce database.json size.
  // These fields are only consumed by the dev-only PageStatus component
  // (hidden by CSS default) and internal dashboard pages that fetch from
  // the wiki-server API. Per-entity bundles retain the full page objects.
  const DASHBOARD_ONLY_PAGE_FIELDS = [
    'coverage',           // ~376 KB — structural completeness (PageStatus dev-only, internal dashboards)
    'metrics',            // ~123 KB — structural metrics (PageStatus dev-only, internal dashboards)
    'redundancy',         // ~25 KB  — similarity data (PageStatus dev-only)
    'suggestedQuality',   // ~1.5 KB — auto-graded quality (PageStatus dev-only)
    'unconvertedLinkCount', // ~0.7 KB — link conversion metric (PageStatus dev-only)
    'unconvertedLinks',   // ~1.4 KB — not referenced in rendering code
    'convertedLinkCount', // ~0.8 KB — link conversion metric (internal dashboards only)
    'changeHistory',      // session change log (PageStatus dev-only)
    'citationHealth',     // citation stats fallback (PageStatus dev-only; live data used when available)
  ];
  if (databaseForOutput.pages) {
    databaseForOutput.pages = databaseForOutput.pages.map(page => {
      const slimmed = { ...page };
      for (const field of DASHBOARD_ONLY_PAGE_FIELDS) {
        delete slimmed[field];
      }
      return slimmed;
    });
  }

  writeFileSync(outputFile, JSON.stringify(databaseForOutput, null, 2));
  const strippedKeys = [
    'benchmarkResults', 'citationQuotes', 'recordVerdicts', 'kbFactVerification',
    'researchAreas', 'pageReferenceIndex', 'prItems', 'updateSchedule',
    'redundancyPairs', 'backlinks', 'relatedGraph', 'resources',
  ];
  console.log(`\n✓ Written: ${outputFile} (stripped: entities, KB, experts, ${strippedKeys.join(', ')})`);
  console.log(`  Page fields stripped: ${DASHBOARD_ONLY_PAGE_FIELDS.join(', ')}`);

  // Write resources to a separate file (lazy-loaded by tablebase.ts)
  const RESOURCES_OUTPUT_FILE = join(OUTPUT_DIR, 'resources.json');
  if (_resources) {
    writeFileSync(RESOURCES_OUTPUT_FILE, JSON.stringify(_resources));
    console.log(`✓ Written: ${RESOURCES_OUTPUT_FILE} (${_resources.length} resources)`);
  }

  // Write FactBase data to a separate file (loaded independently by factbase.ts)
  const FACTBASE_OUTPUT_FILE = join(OUTPUT_DIR, 'factbase-data.json');
  if (_kbData) {
    writeFileSync(FACTBASE_OUTPUT_FILE, JSON.stringify(_kbData, null, 2));
    console.log(`✓ Written: ${FACTBASE_OUTPUT_FILE} (FactBase facts, records, schemas — entities owned by TableBase)`);
  } else {
    console.warn('⚠ FactBase data not available — factbase-data.json not written');
  }

  return {
    databaseForOutput,
    kbData: _kbData,
    // Pass stripped fields needed by per-entity bundle writer
    strippedFields: {
      citationQuotes: _citationQuotes,
      pageReferenceIndex: _pageReferenceIndex,
    },
  };
}

/**
 * Write individual JSON files for each data source and derived data.
 *
 * @param {object} opts
 * @param {object} opts.database - The full database object
 * @param {Array<{key: string, file?: string, dir?: string}>} opts.dataFiles - DATA_FILES config
 * @param {object} opts.backlinks
 * @param {object} opts.tagIndex
 * @param {object} opts.stats
 * @param {object} opts.pathRegistry
 * @param {Array<object>} opts.pages
 * @param {object} opts.relatedGraph
 * @param {object} opts.blockIndex
 */
export function writeIndividualFiles({ database, dataFiles, backlinks, tagIndex, stats, pathRegistry, pages, relatedGraph, blockIndex }) {
  // Write individual source data files
  for (const { key, file, dir } of dataFiles) {
    const jsonFile = dir ? `${key}.json` : file.replace('.yaml', '.json');
    writeFileSync(join(OUTPUT_DIR, jsonFile), JSON.stringify(database[key], null, 2));
  }

  // Write derived data as separate files
  writeFileSync(join(OUTPUT_DIR, 'backlinks.json'), JSON.stringify(backlinks, null, 2));
  writeFileSync(join(OUTPUT_DIR, 'tagIndex.json'), JSON.stringify(tagIndex, null, 2));
  writeFileSync(join(OUTPUT_DIR, 'stats.json'), JSON.stringify(stats, null, 2));
  writeFileSync(join(OUTPUT_DIR, 'pathRegistry.json'), JSON.stringify(pathRegistry, null, 2));
  writeFileSync(join(OUTPUT_DIR, 'pages.json'), JSON.stringify(pages, null, 2));
  writeFileSync(join(OUTPUT_DIR, 'relatedGraph.json'), JSON.stringify(relatedGraph, null, 2));
  if (Object.keys(blockIndex).length > 0) {
    writeFileSync(join(OUTPUT_DIR, 'block-index.json'), JSON.stringify(blockIndex));
    console.log(`✓ Written block-index.json (${Object.keys(blockIndex).length} pages)`);
  }

  console.log('✓ Written individual JSON files');
  console.log('✓ Written derived data files (backlinks, tagIndex, stats, pathRegistry)');
}

/**
 * Generate per-entity JSON bundles containing all data needed to render
 * each entity's wiki page.
 *
 * @param {object} opts
 * @param {Array<object>} opts.typedEntities
 * @param {Array<object>} opts.pages
 * @param {object} opts.backlinks
 * @param {object} opts.relatedGraph
 * @param {object} opts.databaseForOutput - The database minus raw entities/KB
 * @param {object} opts.strippedFields - Fields stripped from databaseForOutput but needed for bundles
 */
export function writePerEntityBundles({ typedEntities, pages, backlinks, relatedGraph, databaseForOutput, strippedFields }) {
  console.log('\nGenerating per-entity JSON files...');
  const ENTITY_DIR = join(OUTPUT_DIR, 'generated', 'entities');
  if (!existsSync(ENTITY_DIR)) {
    mkdirSync(ENTITY_DIR, { recursive: true });
  }

  // Scan existing .json files before writing so we can remove stale ones afterward
  const existingEntityFiles = new Set(
    readdirSync(ENTITY_DIR).filter(f => f.endsWith('.json'))
  );

  // Build lookup maps for efficient per-entity bundling
  const typedEntityMap = new Map(typedEntities.map(e => [e.id, e]));
  const pageMap = new Map(pages.map(p => [p.id, p]));

  // Collect all entity IDs that have either a typed entity or a page
  const allEntityIds = new Set([
    ...typedEntities.map(e => e.id),
    ...pages.map(p => p.id),
  ]);

  const writtenEntityFiles = new Set();
  let entityFilesWritten = 0;
  for (const entityId of allEntityIds) {
    const bundle = {};

    // Entity data
    const entity = typedEntityMap.get(entityId);
    if (entity) bundle.entity = entity;

    // Page metadata
    const page = pageMap.get(entityId);
    if (page) bundle.page = page;

    // Backlinks for this entity
    const entityBacklinks = backlinks[entityId];
    if (entityBacklinks) bundle.backlinks = entityBacklinks;

    // Related graph entries
    const entityRelated = relatedGraph[entityId];
    if (entityRelated) bundle.relatedGraph = entityRelated;

    // Citation quotes (from strippedFields — not in databaseForOutput)
    const entityCitationQuotes = strippedFields?.citationQuotes?.[entityId];
    if (entityCitationQuotes) bundle.citationQuotes = entityCitationQuotes;

    // Page references (from strippedFields — not in databaseForOutput)
    const entityPageRefs = strippedFields?.pageReferenceIndex?.[entityId];
    if (entityPageRefs) bundle.pageReferences = entityPageRefs;

    // Page resources
    const entityPageResources = databaseForOutput.pageResources?.[entityId];
    if (entityPageResources) bundle.pageResources = entityPageResources;

    // Only write if there's meaningful data
    if (Object.keys(bundle).length > 0) {
      // Sanitize entityId for use as filename (some IDs contain path separators like __index__/...)
      const safeFilename = entityId.replace(/\//g, '__');
      const filename = `${safeFilename}.json`;
      writeFileSync(join(ENTITY_DIR, filename), JSON.stringify(bundle));
      writtenEntityFiles.add(filename);
      entityFilesWritten++;
    }
  }

  // Remove stale entity files from previous builds (deleted/renamed entities)
  let staleFilesRemoved = 0;
  for (const existingFile of existingEntityFiles) {
    if (!writtenEntityFiles.has(existingFile)) {
      unlinkSync(join(ENTITY_DIR, existingFile));
      staleFilesRemoved++;
    }
  }
  console.log(`✓ Written ${entityFilesWritten} per-entity JSON files to ${ENTITY_DIR}`);
  if (staleFilesRemoved > 0) {
    console.log(`  Removed ${staleFilesRemoved} stale entity file(s)`);
  }
}

/**
 * Generate link health data by running the validate-internal-links script.
 */
export function generateLinkHealth() {
  console.log('\nGenerating link health data...');
  const linkHealthPath = join(OUTPUT_DIR, 'link-health.json');
  const linkValidation = spawnSync('node', [
    'scripts/validate/validate-internal-links.mjs',
    '--ci',
    `--output=${linkHealthPath}`
  ], { encoding: 'utf-8', cwd: process.cwd() });

  if (linkValidation.status === 0 || linkValidation.status === 1) {
    // Exit 0 = all valid, Exit 1 = broken links found
    // Both are acceptable for data generation
    console.log('✓ Link health data generated');
  } else {
    console.error('⚠️  Link health generation failed:', linkValidation.stderr);
  }
}

/**
 * Generate entity completeness matrix by running the generate script.
 */
export function generateEntityMatrix() {
  console.log('\nGenerating entity completeness matrix...');
  const matrixResult = spawnSync('node', [
    '--import', 'tsx/esm', '--no-warnings',
    '../../crux/entity-matrix/generate.ts',
  ], { encoding: 'utf-8', cwd: process.cwd() });
  if (matrixResult.stdout) process.stdout.write(matrixResult.stdout);
  if (matrixResult.status !== 0) {
    console.warn('⚠ Entity matrix generation failed:', matrixResult.stderr?.slice(0, 200));
  }
}
