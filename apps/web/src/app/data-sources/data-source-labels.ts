/** Shared label maps for data source formats and record types. */

export const FORMAT_LABELS: Record<string, string> = {
  csv: "CSV",
  html_table: "HTML",
  json_api: "JSON",
  spreadsheet: "Sheet",
};

export const RECORD_TYPE_LABELS: Record<string, string> = {
  grant: "Grant",
  personnel: "Personnel",
  investment: "Investment",
  publication: "Publication",
  mixed: "Mixed",
};

export const FORMAT_COLORS: Record<string, string> = {
  csv: "text-blue-600",
  html_table: "text-purple-600",
  json_api: "text-green-600",
  spreadsheet: "text-orange-600",
};

export const RECORD_TYPE_COLORS: Record<string, string> = {
  grant: "text-violet-600",
  personnel: "text-sky-600",
  investment: "text-amber-600",
  publication: "text-teal-600",
  mixed: "text-gray-600",
};
