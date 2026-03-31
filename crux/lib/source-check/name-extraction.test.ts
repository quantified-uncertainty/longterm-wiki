/**
 * Tests for the verdict reasoning name extraction regex.
 * This regex is used in the resolve-names endpoint fallback to extract
 * person/entity names from verdict reasoning when the original record
 * has been deleted from its source table.
 */
import { describe, it, expect } from 'vitest';

/**
 * Extracts a person/item name from verdict reasoning text.
 * Matches patterns like "confirms that [Name]..." or "identifies [Name]..."
 */
function extractNameFromReasoning(reasoning: string): string | null {
  const nameMatch = reasoning.match(
    /(?:confirms?\s+(?:that\s+)?|identifies?\s+|mentions?\s+|states?\s+(?:that\s+)?)([A-Z][a-zA-Z.''-]+(?:\s+[A-Z][a-zA-Z.''-]+){0,4})/
  );
  return nameMatch?.[1]?.trim() ?? null;
}

describe('extractNameFromReasoning', () => {
  it('extracts name from "confirms that [Name] joined..."', () => {
    const reasoning =
      'The source text explicitly confirms that Valerie Blain-Smith joined the Bezos Earth Fund as Chief People Officer in 2022.';
    expect(extractNameFromReasoning(reasoning)).toBe('Valerie Blain-Smith');
  });

  it('extracts name from "confirms that [Name] joined..." with middle name', () => {
    const reasoning =
      'The source confirms that Leon Clarke joined the Bezos Earth Fund as Director of Decarbonization Pathways.';
    expect(extractNameFromReasoning(reasoning)).toBe('Leon Clarke');
  });

  it('extracts name from "confirms [Name]..."', () => {
    const reasoning =
      "The source confirms Christine Peterson's role as co-founder of the Foresight Institute.";
    expect(extractNameFromReasoning(reasoning)).toBe("Christine Peterson's");
  });

  it('extracts name from "identifies [Name]..."', () => {
    const reasoning =
      'The source identifies Peter Diamandis as a board member of the Foresight Institute.';
    expect(extractNameFromReasoning(reasoning)).toBe('Peter Diamandis');
  });

  it('extracts name from "states that [Name]..."', () => {
    const reasoning =
      'The source states that K. Eric Drexler founded the Foresight Institute.';
    expect(extractNameFromReasoning(reasoning)).toBe('K. Eric Drexler');
  });

  it('returns null when no name pattern is found', () => {
    const reasoning = 'The data does not match any known source material.';
    expect(extractNameFromReasoning(reasoning)).toBeNull();
  });

  it('returns null for empty reasoning', () => {
    expect(extractNameFromReasoning('')).toBeNull();
  });

  it('extracts multi-word names', () => {
    const reasoning =
      'The source confirms that Brandon Goldman serves as Executive Director.';
    expect(extractNameFromReasoning(reasoning)).toBe('Brandon Goldman');
  });

  it('handles names with hyphens', () => {
    const reasoning =
      'The source confirms that Valerie Blain-Smith joined the organization.';
    expect(extractNameFromReasoning(reasoning)).toBe('Valerie Blain-Smith');
  });
});
