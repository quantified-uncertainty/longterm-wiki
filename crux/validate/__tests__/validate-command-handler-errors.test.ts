import { describe, it, expect } from 'vitest';
import { scanHandlers } from '../validate-command-handler-errors.ts';

const PATH = '/fake';

describe('scanHandlers — command handler error boundary detection', () => {
  it('flags an unsafe handler without top-level try/catch', () => {
    const code = `
async function badHandler(
  args: string[],
  options: CommandOptions,
): Promise<CommandResult> {
  const r = writeFileSync('/tmp/x', 'data');
  return { exitCode: 0, output: 'ok' };
}
`;
    const findings = scanHandlers(PATH, code);
    expect(findings).toHaveLength(1);
    expect(findings[0].name).toBe('badHandler');
    expect(findings[0].status).toBe('unsafe');
  });

  it('passes a handler that starts with try {', () => {
    const code = `
async function goodHandler(
  args: string[],
  options: CommandOptions,
): Promise<CommandResult> {
  try {
    writeFileSync('/tmp/x', 'data');
    return { exitCode: 0, output: 'ok' };
  } catch (e) {
    return { exitCode: 1, output: String(e) };
  }
}
`;
    const findings = scanHandlers(PATH, code);
    expect(findings).toHaveLength(1);
    expect(findings[0].status).toBe('safe');
    expect(findings[0].safeReason).toBe('try-catch');
  });

  it('respects the `// handler-safe` marker on the line above', () => {
    const code = `
// handler-safe: pure formatter, cannot throw
async function listHandler(
  args: string[],
  options: CommandOptions,
): Promise<CommandResult> {
  return { exitCode: 0, output: formatTable() };
}
`;
    const findings = scanHandlers(PATH, code);
    expect(findings).toHaveLength(1);
    expect(findings[0].status).toBe('safe');
    expect(findings[0].safeReason).toBe('handler-safe-marker');
  });

  it('ignores async functions that are not CommandResult handlers', () => {
    const code = `
async function fetchData(url: string): Promise<string> {
  return fetch(url).then((r) => r.text());
}
async function doStuff(args: string[]): Promise<void> {
  // nothing
}
`;
    expect(scanHandlers(PATH, code)).toHaveLength(0);
  });

  it('handles single-line signatures', () => {
    const code = `
async function quick(args: string[], options: CommandOptions): Promise<CommandResult> {
  return { exitCode: 0, output: '' };
}
`;
    const findings = scanHandlers(PATH, code);
    expect(findings).toHaveLength(1);
    expect(findings[0].status).toBe('unsafe');
  });

  it('handles export async function', () => {
    const code = `
export async function expo(args: string[], options: CommandOptions): Promise<CommandResult> {
  try {
    return { exitCode: 0, output: '' };
  } catch {
    return { exitCode: 1, output: '' };
  }
}
`;
    const findings = scanHandlers(PATH, code);
    expect(findings).toHaveLength(1);
    expect(findings[0].status).toBe('safe');
  });

  it('catches multiple handlers in one file', () => {
    const code = `
async function a(x: S, o: O): Promise<CommandResult> {
  return { exitCode: 0, output: '' };
}
async function b(x: S, o: O): Promise<CommandResult> {
  try { return { exitCode: 0, output: '' }; } catch { return { exitCode: 1, output: '' }; }
}
async function c(x: S, o: O): Promise<CommandResult> {
  doThing();
  return { exitCode: 0, output: '' };
}
`;
    const findings = scanHandlers(PATH, code);
    expect(findings).toHaveLength(3);
    expect(findings.find((f) => f.name === 'a')?.status).toBe('unsafe');
    expect(findings.find((f) => f.name === 'b')?.status).toBe('safe');
    expect(findings.find((f) => f.name === 'c')?.status).toBe('unsafe');
  });

  it('ignores leading comments when locating the first statement', () => {
    const code = `
async function commented(x: S, o: O): Promise<CommandResult> {
  // leading comment
  /* block comment */
  try {
    return { exitCode: 0, output: '' };
  } catch { return { exitCode: 1, output: '' }; }
}
`;
    const findings = scanHandlers(PATH, code);
    expect(findings[0].status).toBe('safe');
  });

  it('passes a handler whose try block comes AFTER arg parsing (real-world pattern)', () => {
    // This is the shape of sentinelWrite/sentinelTouch after QUA-339 pass-2:
    // parse/validate first, then wrap the I/O portion in try/catch.
    const code = `
async function sentinelWrite(args: string[], options: RoleOptions): Promise<CommandResult> {
  const role = parseRole(options);
  if (typeof role !== 'string') return { exitCode: 1, output: role.error };
  const env = makeSentinelEnv();
  try {
    const result = writeSentinelImpl(role, env);
    return { exitCode: 0, output: 'wrote: ' + result.path };
  } catch (e) {
    return { exitCode: 1, output: 'failed: ' + e };
  }
}
`;
    const findings = scanHandlers(PATH, code);
    expect(findings).toHaveLength(1);
    expect(findings[0].status).toBe('safe');
    expect(findings[0].safeReason).toBe('try-catch');
  });

  it('flags a handler with try ONLY inside a nested block (not top-level)', () => {
    const code = `
async function nested(args: string[], options: CommandOptions): Promise<CommandResult> {
  for (const x of items) {
    try { doThing(x); } catch {}
  }
  return { exitCode: 0, output: '' };
}
`;
    const findings = scanHandlers(PATH, code);
    // The `try` is at depth 2 (inside the for loop), not depth 1,
    // so the body has no top-level error boundary.
    expect(findings[0].status).toBe('unsafe');
  });

  // QUA-363 hostile-review HIGH-1: brace counter was fooled by unbalanced
  // `{` or `}` inside string literals. Regression tests for each shape.
  it('is not fooled by `{` inside a double-quoted string literal', () => {
    const code = `
async function stringBrace(x: S, o: O): Promise<CommandResult> {
  const s = "{ not a real brace }";
  try {
    return { exitCode: 0, output: s };
  } catch {
    return { exitCode: 1, output: '' };
  }
}
`;
    expect(scanHandlers(PATH, code)[0].status).toBe('safe');
  });

  it('is not fooled by `}` inside a single-quoted string literal', () => {
    const code = `
async function stringCloseBrace(x: S, o: O): Promise<CommandResult> {
  const s = '}';
  try {
    return { exitCode: 0, output: s };
  } catch {
    return { exitCode: 1, output: '' };
  }
}
`;
    expect(scanHandlers(PATH, code)[0].status).toBe('safe');
  });

  it('is not fooled by escape sequences inside strings (`"\\""`)', () => {
    const code = `
async function escaped(x: S, o: O): Promise<CommandResult> {
  const s = "escaped \\" and {";
  try {
    return { exitCode: 0, output: s };
  } catch {
    return { exitCode: 1, output: '' };
  }
}
`;
    expect(scanHandlers(PATH, code)[0].status).toBe('safe');
  });

  it('is not fooled by a `try` token that appears inside a string', () => {
    // `"please try again"` used to incorrectly match the `try ` pattern.
    // After stripStringLiterals the string contents become spaces.
    const code = `
async function tryInString(x: S, o: O): Promise<CommandResult> {
  const msg = "please try again";
  return { exitCode: 1, output: msg };
}
`;
    expect(scanHandlers(PATH, code)[0].status).toBe('unsafe');
  });

  it('is not fooled by `{` inside a line comment', () => {
    // Regression: pre-fix brace counter treated `// {` as an unbalanced
    // open brace, shifting depth and causing the real try to appear
    // at depth 2 instead of depth 1.
    const code = `
async function withComment(x: S, o: O): Promise<CommandResult> {
  // this { is a comment
  try {
    return { exitCode: 0, output: '' };
  } catch {
    return { exitCode: 1, output: '' };
  }
}
`;
    expect(scanHandlers(PATH, code)[0].status).toBe('safe');
  });

  it('reports accurate line numbers', () => {
    const code = [
      '',
      '',
      'async function foo(x: S, o: O): Promise<CommandResult> {',
      '  return { exitCode: 0, output: "" };',
      '}',
    ].join('\n');
    const findings = scanHandlers(PATH, code);
    expect(findings[0].line).toBe(3);
  });
});
