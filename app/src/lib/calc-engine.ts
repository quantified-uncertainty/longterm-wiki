/**
 * Calc Engine — Expression evaluator for inline wiki calculations.
 *
 * Evaluates mathematical expressions with {entity.factId} references,
 * resolving values from the canonical facts database.
 *
 * Ported from app/scripts/lib/computed-facts.mjs (recursive descent parser)
 * with TypeScript types and formatting additions.
 */

import type { Fact } from "@/data";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CalcResult {
  /** The computed numeric value */
  value: number;
  /** Formatted display string */
  display: string;
  /** Facts referenced in the expression, with resolved values */
  inputs: Array<{
    ref: string;
    entity: string;
    factId: string;
    value: string | undefined;
    numeric: number;
    asOf: string | undefined;
  }>;
  /** The original expression */
  expr: string;
}

export type CalcFormat = "currency" | "percent" | "number";

export interface CalcOptions {
  format?: CalcFormat;
  precision?: number;
  prefix?: string;
  suffix?: string;
}

// ---------------------------------------------------------------------------
// Expression evaluator (recursive descent, no eval())
// ---------------------------------------------------------------------------

interface Token {
  type: "num" | "op";
  value: number | string;
}

function tokenize(expr: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < expr.length) {
    if (/\s/.test(expr[i])) {
      i++;
      continue;
    }
    if ("+-*/()^".includes(expr[i])) {
      tokens.push({ type: "op", value: expr[i] });
      i++;
    } else if (/[\d.]/.test(expr[i])) {
      let num = "";
      while (i < expr.length && /[\d.eE]/.test(expr[i])) {
        num += expr[i];
        i++;
      }
      // Handle signed exponent (e.g., 3.5e+12, 1e-7)
      if (/[eE]$/.test(num) && i < expr.length && (expr[i] === "+" || expr[i] === "-")) {
        num += expr[i];
        i++;
        while (i < expr.length && /\d/.test(expr[i])) {
          num += expr[i];
          i++;
        }
      }
      tokens.push({ type: "num", value: parseFloat(num) });
    } else {
      throw new Error(`Unexpected character "${expr[i]}" at position ${i}`);
    }
  }
  return tokens;
}

function evaluate(tokens: Token[]): number {
  let pos = 0;

  function peek(): Token | undefined {
    return tokens[pos];
  }
  function consume(expected?: string): Token {
    const t = tokens[pos++];
    if (expected && (t?.type !== "op" || t?.value !== expected)) {
      throw new Error(`Expected "${expected}" but got "${t?.value}"`);
    }
    return t;
  }

  function parseExpr(): number {
    let left = parseTerm();
    while (peek()?.type === "op" && (peek()!.value === "+" || peek()!.value === "-")) {
      const op = consume().value;
      const right = parseTerm();
      left = op === "+" ? left + right : left - right;
    }
    return left;
  }

  function parseTerm(): number {
    let left = parsePower();
    while (peek()?.type === "op" && (peek()!.value === "*" || peek()!.value === "/")) {
      const op = consume().value;
      const right = parsePower();
      if (op === "/") {
        if (right === 0) throw new Error("Division by zero");
        left = left / right;
      } else {
        left = left * right;
      }
    }
    return left;
  }

  function parsePower(): number {
    let base = parseFactor();
    while (peek()?.type === "op" && peek()!.value === "^") {
      consume("^");
      const exp = parseFactor();
      base = Math.pow(base, exp);
    }
    return base;
  }

  function parseFactor(): number {
    const t = peek();
    if (!t) throw new Error("Unexpected end of expression");

    if (t.type === "num") {
      pos++;
      return t.value as number;
    }
    if (t.type === "op" && t.value === "(") {
      consume("(");
      const val = parseExpr();
      consume(")");
      return val;
    }
    if (t.type === "op" && t.value === "-") {
      consume();
      return -parseFactor();
    }
    throw new Error(`Unexpected token: ${JSON.stringify(t)}`);
  }

  const result = parseExpr();
  if (pos < tokens.length) {
    throw new Error(
      `Unexpected tokens after expression: ${tokens
        .slice(pos)
        .map((t) => t.value)
        .join(" ")}`
    );
  }
  return result;
}

// ---------------------------------------------------------------------------
// Fact resolution
// ---------------------------------------------------------------------------

interface ResolvedRef {
  ref: string;
  entity: string;
  factId: string;
  fact: Fact | undefined;
  numeric: number;
}

function resolveRefs(
  expr: string,
  factLookup: (entity: string, factId: string) => Fact | undefined
): { resolved: string; refs: ResolvedRef[] } {
  const refs: ResolvedRef[] = [];

  const resolved = expr.replace(/\{([^}]+)\}/g, (_match, ref: string) => {
    const dotIdx = ref.indexOf(".");
    if (dotIdx === -1) {
      throw new Error(`Invalid fact reference: {${ref}} — expected {entity.factId}`);
    }
    const entity = ref.slice(0, dotIdx);
    const factId = ref.slice(dotIdx + 1);
    const fact = factLookup(entity, factId);

    if (!fact) {
      throw new Error(`Unknown fact: {${ref}}`);
    }
    if (fact.numeric == null) {
      throw new Error(`Fact {${ref}} has no numeric value`);
    }

    refs.push({ ref, entity, factId, fact, numeric: fact.numeric });
    return String(fact.numeric);
  });

  return { resolved, refs };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function autoFormat(n: number): string {
  if (!isFinite(n)) return String(n);
  const abs = Math.abs(n);
  if (abs >= 1e12) return `${(n / 1e12).toFixed(1)} trillion`;
  if (abs >= 1e9) return `${(n / 1e9).toFixed(1)} billion`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(1)} million`;
  if (abs >= 1e3) return n.toLocaleString("en-US");
  // Small numbers: show reasonable precision
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(2);
}

export function formatValue(n: number, opts: CalcOptions = {}): string {
  const { format, precision, prefix = "", suffix = "" } = opts;

  let formatted: string;

  if (format === "currency") {
    const abs = Math.abs(n);
    const sign = n < 0 ? "-" : "";
    if (precision != null) {
      if (abs >= 1e12) formatted = `${sign}$${(abs / 1e12).toFixed(precision)} trillion`;
      else if (abs >= 1e9) formatted = `${sign}$${(abs / 1e9).toFixed(precision)} billion`;
      else if (abs >= 1e6) formatted = `${sign}$${(abs / 1e6).toFixed(precision)} million`;
      else formatted = `${sign}$${abs.toLocaleString("en-US", { minimumFractionDigits: precision, maximumFractionDigits: precision })}`;
    } else {
      if (abs >= 1e12) formatted = `${sign}$${(abs / 1e12).toFixed(1)} trillion`;
      else if (abs >= 1e9) formatted = `${sign}$${(abs / 1e9).toFixed(1)} billion`;
      else if (abs >= 1e6) formatted = `${sign}$${(abs / 1e6).toFixed(1)} million`;
      else formatted = `${sign}$${abs.toLocaleString("en-US")}`;
    }
  } else if (format === "percent") {
    const pct = n * 100;
    formatted = precision != null ? `${pct.toFixed(precision)}%` : `${Math.round(pct)}%`;
  } else if (format === "number") {
    formatted =
      precision != null
        ? n.toLocaleString("en-US", { minimumFractionDigits: precision, maximumFractionDigits: precision })
        : n.toLocaleString("en-US");
  } else {
    // Auto-detect
    if (precision != null) {
      formatted = n.toFixed(precision);
    } else {
      formatted = autoFormat(n);
    }
  }

  return `${prefix}${formatted}${suffix}`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Evaluate a calculation expression with {entity.factId} references.
 *
 * @param expr - Expression like "{anthropic.valuation} / {anthropic.revenue-arr-2025}"
 * @param factLookup - Function to resolve (entity, factId) → Fact
 * @param opts - Formatting options
 * @returns CalcResult with value, formatted display, and input metadata
 */
export function calc(
  expr: string,
  factLookup: (entity: string, factId: string) => Fact | undefined,
  opts: CalcOptions = {}
): CalcResult {
  const { resolved, refs } = resolveRefs(expr, factLookup);
  const tokens = tokenize(resolved);
  const value = evaluate(tokens);
  const display = formatValue(value, opts);

  return {
    value,
    display,
    inputs: refs.map((r) => ({
      ref: r.ref,
      entity: r.entity,
      factId: r.factId,
      value: r.fact?.value,
      numeric: r.numeric,
      asOf: r.fact?.asOf,
    })),
    expr,
  };
}
