/**
 * Shared YAML loading utilities.
 *
 * Always loads YAML with `JSON_SCHEMA` to prevent js-yaml from silently
 * coercing bare date strings (e.g. `2026-02-18`) into JavaScript Date objects.
 * Raw Date objects passed to React server components cause "Objects are not
 * valid as a React child" crashes.
 */

import yaml from "js-yaml";

/**
 * Load a YAML string and return the parsed value.
 * Uses JSON_SCHEMA so that bare date strings stay as strings.
 */
export function loadYaml<T = unknown>(raw: string): T {
  return yaml.load(raw, { schema: yaml.JSON_SCHEMA }) as T;
}
