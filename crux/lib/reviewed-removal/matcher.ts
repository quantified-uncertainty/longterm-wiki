import type { Target } from './model.ts';

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const fold = (s: string) => s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const withoutUrls = (s: string) => s.replace(/https?:\/\/[^\s<>"\[\]]+/g, '');

/** Full names and explicit IDs only. Short aliases require case-sensitive matching. */
export function createMatcher(targets: Target[]) {
  const ids = new Set(targets.flatMap(t => t.ids));
  const idPatterns = new Map(targets.map(target => [target, target.ids.map(id => new RegExp('(?<![\\w-])' + escape(id) + '(?![\\w-])'))]));
  const aliases = targets.flatMap(target => target.aliases.map(alias => ({ target, alias, pattern: new RegExp('(?<![\\p{L}\\p{N}_-])' + escape(alias).replace(/ /g, '[\\s._–—-]+') + '(?![\\p{L}\\p{N}_-])', alias.length <= 5 || (target.caseSensitiveAliases??[]).includes(alias) ? 'u' : 'iu') })));
  return {
    identity(value: unknown): boolean {
      return typeof value === 'string' && (ids.has(value) || aliases.some(a => a.alias.length <= 5 ? value === a.alias : fold(value) === fold(a.alias)));
    },
    matches(value: string): Target[] {
      const text = withoutUrls(value);
      return targets.filter(target => idPatterns.get(target)!.some(pattern => pattern.test(text)) || aliases.some(a => a.target === target && a.pattern.test(text)));
    },
    /** Strip identities/associations in structured fields. Prose becomes a review task. */
    structured(value: unknown): unknown {
      if (typeof value === 'string') return this.identity(value) ? null : value;
      if (Array.isArray(value)) return value.filter(item => !this.identity(item) && !(item && typeof item === 'object' && ['id', 'name', 'personId', 'entityId', 'stableId', 'author'].some(k => this.identity((item as Record<string, unknown>)[k])))).map(item => this.structured(item));
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, this.structured(v)]));
      return value;
    },
  };
}

export function resolveName(name: string, catalog: Array<{ name: string; type: string; ids: string[]; aliases?: string[] }>): Target[] {
  if (!name.trim()) throw new Error('Enter a person or organization name');
  return catalog.filter(row => [row.name, ...(row.aliases ?? []), ...row.ids].some(n => fold(n) === fold(name)) && ['person', 'organization'].includes(row.type)).map(row => ({ name: row.name, type: row.type as Target['type'], ids: row.ids, aliases: row.aliases ?? [row.name] }));
}
