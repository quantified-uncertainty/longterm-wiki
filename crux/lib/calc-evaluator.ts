/**
 * Standalone Expression Evaluator for the Crux CLI
 *
 * A stripped-down version of app/src/lib/calc-engine.ts, adapted
 * for use in the crux/ directory without Next.js path aliases.
 *
 * Evaluates math expressions with {entity.factId} references,
 * resolving values from a caller-supplied lookup function.
 *
 * Used by crux/facts/calc-derive.ts to validate proposed <Calc> expressions
 * before applying them to MDX files.
 */

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

interface Token {
  type: 'num' | 'op';
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
    if ('+-*/()^'.includes(expr[i])) {
      tokens.push({ type: 'op', value: expr[i] });
      i++;
    } else if (/[\d.]/.test(expr[i])) {
      let num = '';
      while (i < expr.length && /[\d.eE]/.test(expr[i])) {
        num += expr[i];
        i++;
      }
      // Handle signed exponent: 3.5e+12, 1e-7
      if (/[eE]$/.test(num) && i < expr.length && (expr[i] === '+' || expr[i] === '-')) {
        num += expr[i];
        i++;
        while (i < expr.length && /\d/.test(expr[i])) {
          num += expr[i];
          i++;
        }
      }
      tokens.push({ type: 'num', value: parseFloat(num) });
    } else {
      throw new Error(`Unexpected character "${expr[i]}" at position ${i}`);
    }
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// Recursive-descent evaluator (no eval)
// ---------------------------------------------------------------------------

function evaluate(tokens: Token[]): number {
  let pos = 0;

  const peek = (): Token | undefined => tokens[pos];
  const consume = (expected?: string): Token => {
    const t = tokens[pos++];
    if (expected && (t?.type !== 'op' || t?.value !== expected)) {
      throw new Error(`Expected "${expected}" but got "${t?.value}"`);
    }
    return t;
  };

  // expr = term (('+' | '-') term)*
  function parseExpr(): number {
    let left = parseTerm();
    while (peek()?.type === 'op' && (peek()!.value === '+' || peek()!.value === '-')) {
      const op = consume().value;
      const right = parseTerm();
      left = op === '+' ? left + right : left - right;
    }
    return left;
  }

  // term = power (('*' | '/') power)*
  function parseTerm(): number {
    let left = parsePower();
    while (peek()?.type === 'op' && (peek()!.value === '*' || peek()!.value === '/')) {
      const op = consume().value;
      const right = parsePower();
      if (op === '/') {
        if (right === 0) throw new Error('Division by zero');
        left = left / right;
      } else {
        left = left * right;
      }
    }
    return left;
  }

  // power = factor ('^' factor)*
  function parsePower(): number {
    let base = parseFactor();
    while (peek()?.type === 'op' && peek()!.value === '^') {
      consume('^');
      base = Math.pow(base, parseFactor());
    }
    return base;
  }

  // factor = NUMBER | '(' expr ')' | '-' factor
  function parseFactor(): number {
    const t = peek();
    if (!t) throw new Error('Unexpected end of expression');
    if (t.type === 'num') {
      pos++;
      return t.value as number;
    }
    if (t.type === 'op' && t.value === '(') {
      consume('(');
      const val = parseExpr();
      consume(')');
      return val;
    }
    if (t.type === 'op' && t.value === '-') {
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
        .map(t => t.value)
        .join(' ')}`
    );
  }
  return result;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Lookup function: given entity + factId, return the numeric value or undefined */
export type FactValueLookup = (entity: string, factId: string) => number | undefined;

/**
 * Evaluate a calc expression string, resolving {entity.factId} references
 * via the provided lookup function. Returns the numeric result.
 *
 * Throws if a reference is unknown, has no numeric value, or the expression
 * has a syntax/math error.
 */
export function evalCalcExpr(expr: string, lookup: FactValueLookup): number {
  const resolved = expr.replace(/\{([^}]+)\}/g, (_match, ref: string) => {
    const dotIdx = ref.indexOf('.');
    if (dotIdx === -1) {
      throw new Error(`Invalid fact reference: {${ref}} — expected {entity.factId}`);
    }
    const entity = ref.slice(0, dotIdx);
    const factId = ref.slice(dotIdx + 1);
    const numeric = lookup(entity, factId);
    if (numeric === undefined) {
      throw new Error(`Unknown or non-numeric fact: {${ref}}`);
    }
    return String(numeric);
  });
  return evaluate(tokenize(resolved));
}

/**
 * Extract all {entity.factId} references from a calc expression.
 */
export function extractFactRefs(expr: string): Array<{ entity: string; factId: string }> {
  const refs: Array<{ entity: string; factId: string }> = [];
  const pattern = /\{([^}]+)\}/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(expr)) !== null) {
    const ref = match[1];
    const dotIdx = ref.indexOf('.');
    if (dotIdx !== -1) {
      refs.push({ entity: ref.slice(0, dotIdx), factId: ref.slice(dotIdx + 1) });
    }
  }
  return refs;
}
