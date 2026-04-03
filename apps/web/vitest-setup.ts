/**
 * Vitest setup for @testing-library/jest-dom matchers.
 * Loaded globally for all tests — the matchers are lightweight and safe in node env.
 * Only useful for test files that opt into jsdom via `// @vitest-environment jsdom`.
 */
import "@testing-library/jest-dom/vitest";
