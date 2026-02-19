/**
 * Computed Facts — Expression Evaluator and Numeric Parser
 *
 * Handles parsing human-readable numeric strings ("$13 billion" → 13_000_000_000),
 * evaluating computed fact expressions with {entity.factId} references using
 * recursive descent parsing, and resolving all computed facts in topological order.
 *
 * Extracted from build-data.mjs for modularity.
 */

/**
 * Auto-parse a numeric value from a human-readable string.
 * Returns null if the string can't be reliably parsed.
 *
 * Examples:
 *   "$350 billion" → 350_000_000_000
 *   "$13 billion"  → 13_000_000_000
 *   "$3.4 billion" → 3_400_000_000
 *   "100 million"  → 100_000_000
 *   "$76,001/year" → 76001
 *   "175 billion"  → 175_000_000_000
 *   "1,900"        → 1900
 *   "40%"          → 0.4
 *   "83%"          → 0.83
 */
export function parseNumericValue(value) {
  if (!value || typeof value !== 'string') return null;

  // Skip ranges and ambiguous values
  if (value.includes(' to ') || (value.includes('-') && value.match(/\d+-\d/))) return null;
  if (value.includes('+') && !value.startsWith('+')) return null; // "300,000+" is ambiguous

  const s = value.trim();

  // Percentage: "40%" → 0.4
  const pctMatch = s.match(/^(\d+(?:\.\d+)?)%$/);
  if (pctMatch) return parseFloat(pctMatch[1]) / 100;

  // Dollar + number + unit: "$13 billion", "$3.4 million"
  const dollarUnitMatch = s.match(/^\$?([\d,.]+)\s*(billion|million|trillion|thousand)?\s*(?:\/\w+)?$/i);
  if (dollarUnitMatch) {
    const num = parseFloat(dollarUnitMatch[1].replace(/,/g, ''));
    if (isNaN(num)) return null;
    const unit = (dollarUnitMatch[2] || '').toLowerCase();
    const multipliers = { trillion: 1e12, billion: 1e9, million: 1e6, thousand: 1e3, '': 1 };
    return num * (multipliers[unit] || 1);
  }

  // Plain number with possible commas: "1,900"
  const plainMatch = s.match(/^[\d,]+(?:\.\d+)?$/);
  if (plainMatch) {
    return parseFloat(s.replace(/,/g, ''));
  }

  return null;
}

/**
 * Safe expression evaluator for computed facts.
 * Supports: numbers, +, -, *, /, parentheses, and {entity.factId} references.
 *
 * Uses recursive descent parsing — no eval().
 */
function evaluateExpression(expression, facts) {
  // Replace {entity.factId} references with numeric values
  const resolved = expression.replace(/\{([^}]+)\}/g, (match, ref) => {
    const fact = facts[ref];
    if (!fact) {
      throw new Error(`Unknown fact reference: ${ref}`);
    }
    if (fact.noCompute) {
      throw new Error(`Fact ${ref} is marked noCompute (not a computable quantity)`);
    }
    if (fact.numeric == null) {
      throw new Error(`Fact ${ref} has no numeric value`);
    }
    return String(fact.numeric);
  });

  // Tokenize
  const tokens = [];
  let i = 0;
  while (i < resolved.length) {
    if (/\s/.test(resolved[i])) { i++; continue; }
    if ('+-*/()'.includes(resolved[i])) {
      tokens.push({ type: 'op', value: resolved[i] });
      i++;
    } else if (/[\d.]/.test(resolved[i])) {
      let num = '';
      while (i < resolved.length && /[\d.eE]/.test(resolved[i])) {
        num += resolved[i]; i++;
      }
      // Handle signed exponent (e.g., 3.5e+12, 1e-7)
      if (/[eE]$/.test(num) && i < resolved.length && (resolved[i] === '+' || resolved[i] === '-')) {
        num += resolved[i]; i++;
        while (i < resolved.length && /\d/.test(resolved[i])) {
          num += resolved[i]; i++;
        }
      }
      tokens.push({ type: 'num', value: parseFloat(num) });
    } else {
      throw new Error(`Unexpected character in expression: "${resolved[i]}" at position ${i}`);
    }
  }

  // Recursive descent parser
  let pos = 0;
  function peek() { return tokens[pos]; }
  function consume(expected) {
    const t = tokens[pos++];
    if (expected && (t?.type !== 'op' || t?.value !== expected)) {
      throw new Error(`Expected "${expected}" but got "${t?.value}"`);
    }
    return t;
  }

  function parseExpr() {
    let left = parseTerm();
    while (peek()?.type === 'op' && (peek().value === '+' || peek().value === '-')) {
      const op = consume().value;
      const right = parseTerm();
      left = op === '+' ? left + right : left - right;
    }
    return left;
  }

  function parseTerm() {
    let left = parseFactor();
    while (peek()?.type === 'op' && (peek().value === '*' || peek().value === '/')) {
      const op = consume().value;
      const right = parseFactor();
      if (op === '/') {
        if (right === 0) throw new Error('Division by zero');
        left = left / right;
      } else {
        left = left * right;
      }
    }
    return left;
  }

  function parseFactor() {
    const t = peek();
    if (!t) throw new Error('Unexpected end of expression');

    if (t.type === 'num') {
      pos++;
      return t.value;
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
    throw new Error(`Unexpected tokens after expression: ${tokens.slice(pos).map(t => t.value).join(' ')}`);
  }
  return result;
}

/**
 * Check if a compute expression references any currency-denominated facts.
 */
function isCurrencyExpression(expression, facts) {
  const refRegex = /\{([^}]+)\}/g;
  let m;
  while ((m = refRegex.exec(expression)) !== null) {
    const fact = facts[m[1]];
    if (fact?.value && fact.value.trim().startsWith('$')) return true;
  }
  return false;
}

/**
 * Format a computed numeric value for display.
 * @param {number} numeric - The computed value
 * @param {string|undefined} format - Printf-style format string
 * @param {number|undefined} formatDivisor - Divisor before formatting
 * @param {boolean} isCurrency - Whether the result is a dollar amount
 */
function formatComputedValue(numeric, format, formatDivisor, isCurrency = false) {
  if (!isFinite(numeric)) throw new Error(`Computed value is ${numeric} (expected a finite number)`);
  const displayNum = formatDivisor ? numeric / formatDivisor : numeric;

  if (!format) {
    const prefix = isCurrency ? '$' : '';
    const n = displayNum;
    // Default: reasonable formatting for large numbers
    if (Math.abs(n) >= 1e12) return `${prefix}${(n / 1e12).toFixed(1)} trillion`;
    if (Math.abs(n) >= 1e9) return `${prefix}${(n / 1e9).toFixed(1)} billion`;
    if (Math.abs(n) >= 1e6) return `${prefix}${(n / 1e6).toFixed(1)} million`;
    return isCurrency ? `${prefix}${n.toLocaleString('en-US')}` : n.toLocaleString('en-US');
  }

  // Simple printf-style: replace %.Nf with the formatted number
  return format.replace(/%(?:\.(\d+))?f/, (_, decimals) => {
    const d = decimals ? parseInt(decimals) : 0;
    return displayNum.toFixed(d);
  });
}

/**
 * Resolve all computed facts in dependency order.
 * Returns count of computed facts.
 */
export function resolveComputedFacts(facts) {
  // Find all computed facts
  const computed = Object.entries(facts).filter(([, f]) => f.compute);
  if (computed.length === 0) return 0;

  // Extract dependencies for each computed fact
  const deps = new Map();
  for (const [key, fact] of computed) {
    const refs = [];
    const refRegex = /\{([^}]+)\}/g;
    let m;
    while ((m = refRegex.exec(fact.compute)) !== null) {
      refs.push(m[1]);
    }
    deps.set(key, refs);
  }

  // Topological sort (Kahn's algorithm)
  const inDegree = new Map();
  const graph = new Map();
  for (const [key, refKeys] of deps) {
    inDegree.set(key, 0);
    graph.set(key, []);
  }
  for (const [key, refKeys] of deps) {
    for (const ref of refKeys) {
      if (deps.has(ref)) {
        // ref is also a computed fact → key depends on ref
        graph.get(ref).push(key);
        inDegree.set(key, (inDegree.get(key) || 0) + 1);
      }
    }
  }

  const queue = [];
  for (const [key, deg] of inDegree) {
    if (deg === 0) queue.push(key);
  }

  const order = [];
  while (queue.length > 0) {
    const current = queue.shift();
    order.push(current);
    for (const dependent of (graph.get(current) || [])) {
      inDegree.set(dependent, inDegree.get(dependent) - 1);
      if (inDegree.get(dependent) === 0) queue.push(dependent);
    }
  }

  if (order.length !== computed.length) {
    const missing = computed.map(([k]) => k).filter(k => !order.includes(k));
    throw new Error(`Circular dependency in computed facts: ${missing.join(', ')}`);
  }

  // Evaluate in order
  let resolved = 0;
  for (const key of order) {
    const fact = facts[key];
    try {
      const numeric = evaluateExpression(fact.compute, facts);
      fact.numeric = numeric;
      const currency = isCurrencyExpression(fact.compute, facts);
      fact.value = formatComputedValue(numeric, fact.format, fact.formatDivisor, currency);
      fact.computed = true;
      resolved++;
    } catch (err) {
      console.warn(`  ⚠️  Failed to compute ${key}: ${err.message}`);
    }
  }

  return resolved;
}
