/**
 * Individual quality check implementations for claims validation.
 *
 * Each function takes a ClaimRow (and optional entity context) and returns
 * a CheckResult indicating pass/fail with an optional detail message.
 */

import type { ClaimRow } from '../../lib/wiki-server/claims.ts';
import type { CheckResult } from './types.ts';
import {
  VAGUE_PATTERNS,
  MDX_PATTERNS,
  VOLATILE_MEASURES,
  VOLATILE_TEXT_PATTERNS,
} from './types.ts';
import {
  slugToDisplayName,
  escapeRegex,
  containsEntityReference,
  isTautologicalDefinition,
} from '../../lib/claim-text-utils.ts';

// ---------------------------------------------------------------------------
// Quality check implementations
// ---------------------------------------------------------------------------

export function checkSelfContained(
  claim: ClaimRow,
  entityId: string,
  entityName: string,
): CheckResult {
  const passed = containsEntityReference(claim.claimText, entityId, entityName);
  return {
    check: 'self-contained',
    passed,
    detail: passed
      ? undefined
      : `missing entity name "${entityName}" or "${entityId}"`,
  };
}

export function checkCorrectlyAttributed(
  claim: ClaimRow,
  entityId: string,
): CheckResult {
  // If subjectEntity is not set, we can't validate — pass by default
  if (!claim.subjectEntity) {
    return { check: 'correctly-attributed', passed: true };
  }

  // subjectEntity should match the entityId or be a known related entity
  const subject = claim.subjectEntity.toLowerCase();
  const entityLower = entityId.toLowerCase();

  // Direct match
  if (subject === entityLower) {
    return { check: 'correctly-attributed', passed: true };
  }

  // Check if subjectEntity is in relatedEntities
  const related = claim.relatedEntities ?? [];
  const isRelated = related.some((r) => r.toLowerCase() === subject);
  if (isRelated) {
    return { check: 'correctly-attributed', passed: true };
  }

  // Check if entityId is in relatedEntities (subject is something else but entity is related)
  const entityIsRelated = related.some((r) => r.toLowerCase() === entityLower);
  if (entityIsRelated) {
    return { check: 'correctly-attributed', passed: true };
  }

  return {
    check: 'correctly-attributed',
    passed: false,
    detail: `subjectEntity "${claim.subjectEntity}" is not "${entityId}" or in relatedEntities`,
  };
}

export function checkCleanText(claim: ClaimRow): CheckResult {
  for (const { pattern, label } of MDX_PATTERNS) {
    if (pattern.test(claim.claimText)) {
      return {
        check: 'clean-text',
        passed: false,
        detail: `contains ${label}`,
      };
    }
  }
  return { check: 'clean-text', passed: true };
}

export function checkAtomic(claim: ClaimRow): CheckResult {
  const text = claim.claimText;

  // Check for semicolons splitting independent clauses
  // (but not semicolons in URLs or data)
  if (/;\s+[A-Z]/.test(text)) {
    return {
      check: 'atomic',
      passed: false,
      detail: 'contains semicolon splitting independent clauses',
    };
  }

  // Check for "and" joining two distinct facts with separate subjects
  // Heuristic: look for patterns like "Subject verb X, and Subject verb Y"
  // or "Subject verb X and also verb Y"
  if (/,\s+and\s+(?:also\s+)?[A-Z]/.test(text)) {
    return {
      check: 'atomic',
      passed: false,
      detail: 'uses ", and [A-Z]" pattern suggesting multiple facts',
    };
  }

  // Check for "Additionally" / "Also" / "Furthermore" mid-sentence joining facts
  if (/\.\s+(?:Additionally|Also|Furthermore|Moreover),?\s+/i.test(text)) {
    return {
      check: 'atomic',
      passed: false,
      detail: 'contains multiple sentences with connective adverbs',
    };
  }

  return { check: 'atomic', passed: true };
}

export function checkSpecific(claim: ClaimRow): CheckResult {
  const text = claim.claimText;
  const hasSpecifics = /\d/.test(text);

  if (!hasSpecifics) {
    for (const { pattern, word } of VAGUE_PATTERNS) {
      if (pattern.test(text)) {
        return {
          check: 'specific',
          passed: false,
          detail: `uses "${word}" without specifics`,
        };
      }
    }
  }

  return { check: 'specific', passed: true };
}

export function checkCorrectlyTyped(claim: ClaimRow): CheckResult {
  const { claimType, claimText, valueNumeric } = claim;

  // If claimType is "numeric" or "quantitative", there should be a valueNumeric or a number in text
  if (
    claimType === 'numeric' ||
    claimType === 'quantitative' ||
    claimType === 'metric'
  ) {
    const hasNumber = valueNumeric != null || /\d/.test(claimText);
    if (!hasNumber) {
      return {
        check: 'correctly-typed',
        passed: false,
        detail: `claimType is "${claimType}" but no numeric value found`,
      };
    }
  }

  // If claimType is "historical" or "temporal", there should be a date reference
  if (claimType === 'historical' || claimType === 'temporal') {
    const hasDate =
      claim.valueDate != null ||
      claim.asOf != null ||
      /\b(?:19|20)\d{2}\b/.test(claimText) ||
      /\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\b/i.test(
        claimText,
      );
    if (!hasDate) {
      return {
        check: 'correctly-typed',
        passed: false,
        detail: `claimType is "${claimType}" but no date reference found`,
      };
    }
  }

  // If text has a clear numeric value but claimType is "descriptive"/"qualitative", warn
  if (
    (claimType === 'descriptive' || claimType === 'qualitative') &&
    valueNumeric != null
  ) {
    return {
      check: 'correctly-typed',
      passed: false,
      detail: `claimType is "${claimType}" but has valueNumeric=${valueNumeric}`,
    };
  }

  return { check: 'correctly-typed', passed: true };
}

export function checkTemporallyGrounded(claim: ClaimRow): CheckResult {
  const { measure, claimText, asOf, valueDate } = claim;

  // Check 1: if the claim has a known volatile measure
  const isVolatileMeasure = measure != null && VOLATILE_MEASURES.has(measure);

  // Check 2: if the claim text mentions volatile topics
  const isVolatileText =
    !isVolatileMeasure &&
    claim.valueNumeric != null &&
    VOLATILE_TEXT_PATTERNS.some((p) => p.test(claimText));

  if (isVolatileMeasure || isVolatileText) {
    const hasTemporalGrounding =
      asOf != null ||
      valueDate != null ||
      /\b(?:as of|in|during|since)\s+(?:19|20)\d{2}\b/i.test(claimText) ||
      /\b(?:Q[1-4])\s+(?:19|20)\d{2}\b/i.test(claimText) ||
      /\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+(?:19|20)\d{2}\b/i.test(
        claimText,
      );

    if (!hasTemporalGrounding) {
      const topic = isVolatileMeasure ? `measure="${measure}"` : 'numeric value with volatile topic';
      return {
        check: 'temporally-grounded',
        passed: false,
        detail: `${topic} lacks temporal grounding (no asOf, valueDate, or date in text)`,
      };
    }
  }

  return { check: 'temporally-grounded', passed: true };
}

export function checkComplete(claim: ClaimRow): CheckResult {
  const text = claim.claimText.trim();

  if (text.length < 20) {
    return {
      check: 'complete',
      passed: false,
      detail: `claim is only ${text.length} chars (min 20)`,
    };
  }

  if (!/[.!?]$/.test(text)) {
    return {
      check: 'complete',
      passed: false,
      detail: 'missing terminal punctuation',
    };
  }

  return { check: 'complete', passed: true };
}

export function checkNonTautological(
  claim: ClaimRow,
  entityId: string,
  entityName: string,
): CheckResult {
  if (isTautologicalDefinition(claim.claimText, entityId, entityName)) {
    return {
      check: 'non-tautological',
      passed: false,
      detail: `merely defines what ${entityName} is`,
    };
  }
  return { check: 'non-tautological', passed: true };
}

export function checkContextuallyComplete(claim: ClaimRow): CheckResult {
  const { claimText, valueNumeric, valueUnit } = claim;

  // Only relevant for claims with numeric values
  if (valueNumeric == null) {
    return { check: 'contextually-complete', passed: true };
  }

  // If there's a valueUnit set, that's sufficient context
  if (valueUnit != null && valueUnit.length > 0) {
    return { check: 'contextually-complete', passed: true };
  }

  // Check if the text itself provides units/context around the number
  // Look for currency symbols, percentage signs, unit words near numbers
  const hasUnitsInText =
    /\$[\d,.]+/.test(claimText) ||
    /[\d,.]+\s*%/.test(claimText) ||
    /[\d,.]+\s*(?:billion|million|thousand|trillion|USD|EUR|GBP)/i.test(claimText) ||
    /[\d,.]+\s*(?:people|employees|users|customers|members|researchers|scientists)/i.test(claimText) ||
    /[\d,.]+\s*(?:years?|months?|days?|hours?|minutes?|seconds?)/i.test(claimText) ||
    /[\d,.]+\s*(?:GB|TB|MB|KB|km|mi|kg|lb|m|ft)/i.test(claimText);

  if (!hasUnitsInText) {
    return {
      check: 'contextually-complete',
      passed: false,
      detail: `has valueNumeric=${valueNumeric} but no unit in valueUnit or claim text`,
    };
  }

  return { check: 'contextually-complete', passed: true };
}
