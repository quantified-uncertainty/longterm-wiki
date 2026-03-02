/**
 * Session Name Generator
 *
 * Generates human-friendly names for agent sessions using
 * adjective-noun-adjective-noun patterns (e.g., "bright-falcon-quiet-river").
 */

const ADJECTIVES = [
  'amber', 'bold', 'bright', 'calm', 'clear',
  'cool', 'coral', 'crisp', 'dark', 'deep',
  'dry', 'dusk', 'fair', 'fast', 'firm',
  'fond', 'fresh', 'glad', 'gold', 'grand',
  'gray', 'green', 'keen', 'kind', 'late',
  'lean', 'light', 'live', 'long', 'lost',
  'loud', 'mild', 'neat', 'new', 'next',
  'odd', 'pale', 'plain', 'prime', 'pure',
  'quick', 'rare', 'raw', 'red', 'rich',
  'ripe', 'safe', 'sharp', 'shy', 'slim',
  'slow', 'soft', 'stark', 'still', 'swift',
  'tall', 'thin', 'vast', 'warm', 'wide',
] as const;

const NOUNS = [
  'ash', 'bay', 'birch', 'bloom', 'brook',
  'cedar', 'cliff', 'cloud', 'cove', 'creek',
  'crow', 'dawn', 'deer', 'dove', 'dune',
  'elm', 'ember', 'fern', 'finch', 'flame',
  'flint', 'fox', 'frost', 'gale', 'glen',
  'grove', 'hawk', 'hazel', 'heron', 'hill',
  'holly', 'jade', 'lake', 'lark', 'leaf',
  'marsh', 'mesa', 'moon', 'moss', 'oak',
  'owl', 'peak', 'pine', 'plum', 'pond',
  'rain', 'reef', 'ridge', 'river', 'rock',
  'sage', 'shore', 'sky', 'slate', 'snow',
  'spruce', 'star', 'stone', 'storm', 'vale',
] as const;

function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * Generate a human-friendly session name.
 *
 * Pattern: adjective-noun-adjective-noun
 * Example: "bright-falcon-quiet-river"
 */
export function generateSessionName(): string {
  return `${pick(ADJECTIVES)}-${pick(NOUNS)}-${pick(ADJECTIVES)}-${pick(NOUNS)}`;
}
