/**
 * Orchestrator Tools — barrel export.
 *
 * Re-exports everything that consumers (orchestrator.ts, quality-gate.ts,
 * tests) need. This keeps the import paths stable when the internal
 * structure changes.
 */

// Registry (build functions for the orchestrator loop)
export { buildToolDefinitions, buildToolHandlers, wrapWithTracking } from './registry.ts';

// Metrics (used by quality-gate.ts and tools themselves)
export { extractQualityMetrics } from './metrics.ts';

// Types (used by tests and the registry)
export type { ToolHandler, ToolRegistration, ToolHandlerOptions } from './types.ts';
