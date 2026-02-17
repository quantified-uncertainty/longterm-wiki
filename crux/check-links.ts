/**
 * Link Rot Detection Script — shim entry point.
 *
 * Delegates to link-checker/index.ts. This file exists for backward
 * compatibility with scripts that reference the original path.
 */

await import('./link-checker/index.ts');
