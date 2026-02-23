/** Shared constants for resource rendering components */

export const typeIcons: Record<string, string> = {
  paper: "\ud83d\udcc4",
  book: "\ud83d\udcda",
  blog: "\u270f\ufe0f",
  report: "\ud83d\udccb",
  talk: "\ud83c\udf99\ufe0f",
  podcast: "\ud83c\udfa7",
  government: "\ud83c\udfdb\ufe0f",
  reference: "\ud83d\udcd6",
  web: "\ud83d\udd17",
};

export function getResourceTypeIcon(type: string): string {
  return typeIcons[type] || "\ud83d\udd17";
}
