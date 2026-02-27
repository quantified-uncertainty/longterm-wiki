/** Detect MDX/JSX markup leakage in claim text */
const MARKUP_RE = /<[A-Z][A-Za-z]*[\s/>]|<\/[A-Z]|\[.*?\]\(.*?\)|```|{\/\*|\*\*[^*]+\*\*/;

export function hasMarkup(text: string): boolean {
  return MARKUP_RE.test(text);
}
