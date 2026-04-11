/**
 * Data Source Manifest — describes the schema, column mapping, and sourcing
 * strategy for a structured data source (CSV, API, HTML table).
 *
 * Part of Phase 2: Data Source Resources (Discussion #3567).
 */

export interface DataSourceManifest {
  /** Matches GrantSource.id and resource_tabular_sources.source_slug */
  sourceId: string;
  /** Human-readable name */
  name: string;
  /** URL to download/scrape the raw data (nullable for manual exports) */
  fetchUrl: string | null;
  /** csv | html_table | json_api | spreadsheet */
  format: 'csv' | 'html_table' | 'json_api' | 'spreadsheet';
  /** How to access the data */
  accessMethod: 'direct_download' | 'api_endpoint' | 'web_scrape' | 'manual_export';
  /** Entity that publishes this data */
  publisherEntityId?: string;
  /** How often the source updates */
  updateFrequency: 'static' | 'weekly' | 'monthly' | 'quarterly' | 'annual';
  /** Path to the cached raw file in /tmp/ */
  cachePath: string;
  /** Schema description of the source's columns */
  schema: {
    fields: DataSourceField[];
    /** Strings that should be treated as null (e.g., ["", "N/A", "-"]) */
    missingValues?: string[];
  };
  /** How to sourcing records against this source */
  sourcing: {
    strategy: 'deterministic_row_match';
    /** Fields used for matching (internal field names, e.g., ['grantee', 'amount', 'date']) */
    matchFields: string[];
    /** Fields where fuzzy matching is allowed (edit distance) */
    fuzzyFields?: string[];
    /** Fields requiring exact match */
    exactFields?: string[];
  };
}

export interface DataSourceField {
  /** Column name in the source (CSV header, API field name, etc.) */
  sourceName: string;
  /** Internal field name this maps to (e.g., 'grantee', 'amount', 'date') */
  internalField?: string;
  /** Data type */
  type?: 'string' | 'number' | 'date' | 'currency';
  /** Transformation to apply when parsing */
  transform?: 'strip_currency' | 'parse_date' | 'normalize_name';
}
