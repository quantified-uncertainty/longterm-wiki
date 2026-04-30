import { describe, it, expect } from 'vitest';
import {
  findSecretRefs,
  findMissingSecrets,
  parseInheritedAllowlist,
} from './validate-workflow-secrets.ts';

describe('validate-workflow-secrets', () => {
  describe('findSecretRefs', () => {
    it('extracts a simple secret reference with line number', () => {
      const refs = findSecretRefs([
        {
          path: '.github/workflows/foo.yml',
          content: 'jobs:\n  run:\n    env:\n      LINEAR_API_KEY: ${{ secrets.LINEAR_API_KEY }}\n',
        },
      ]);
      expect(refs).toEqual([
        { file: '.github/workflows/foo.yml', line: 4, name: 'LINEAR_API_KEY' },
      ]);
    });

    it('extracts multiple references on the same line', () => {
      const refs = findSecretRefs([
        {
          path: 'a.yml',
          content: 'foo: ${{ secrets.A }} bar: ${{ secrets.B }}\n',
        },
      ]);
      expect(refs.map((r) => r.name)).toEqual(['A', 'B']);
      expect(refs.every((r) => r.line === 1)).toBe(true);
    });

    it('extracts references across multiple files', () => {
      const refs = findSecretRefs([
        { path: 'a.yml', content: '${{ secrets.A }}\n' },
        { path: 'b.yml', content: '${{ secrets.B }}\n' },
      ]);
      expect(refs).toHaveLength(2);
      expect(refs.find((r) => r.name === 'A')?.file).toBe('a.yml');
      expect(refs.find((r) => r.name === 'B')?.file).toBe('b.yml');
    });

    it('excludes secrets.GITHUB_TOKEN (auto-provided)', () => {
      const refs = findSecretRefs([
        {
          path: 'a.yml',
          content: 'GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}\nLINEAR_API_KEY: ${{ secrets.LINEAR_API_KEY }}\n',
        },
      ]);
      expect(refs.map((r) => r.name)).toEqual(['LINEAR_API_KEY']);
    });

    it('tolerates whitespace inside the expression', () => {
      const refs = findSecretRefs([
        { path: 'a.yml', content: '${{secrets.NO_SPACE}}\n${{    secrets.LOTS_OF_SPACE   }}\n' },
      ]);
      expect(refs.map((r) => r.name)).toEqual(['NO_SPACE', 'LOTS_OF_SPACE']);
    });

    it('does not match other expression contexts (e.g. env., vars., inputs.)', () => {
      const refs = findSecretRefs([
        {
          path: 'a.yml',
          content: '${{ env.FOO }}\n${{ vars.BAR }}\n${{ inputs.BAZ }}\n${{ secrets.QUX }}\n',
        },
      ]);
      expect(refs.map((r) => r.name)).toEqual(['QUX']);
    });

    it('matches secrets with || fallback expression syntax', () => {
      // Real-world example from .github/workflows/database-backup.yml:
      //   AWS_REGION: ${{ secrets.AWS_REGION || 'us-east-1' }}
      // The earlier regex required `}}` to immediately follow the name
      // and silently missed this — exactly the QUA-676 footgun.
      const refs = findSecretRefs([
        {
          path: 'database-backup.yml',
          content: "AWS_REGION: ${{ secrets.AWS_REGION || 'us-east-1' }}\n",
        },
      ]);
      expect(refs).toEqual([
        { file: 'database-backup.yml', line: 1, name: 'AWS_REGION' },
      ]);
    });

    it('matches secrets in conditional expressions (== / && / ?:)', () => {
      const refs = findSecretRefs([
        { path: 'a.yml', content: "if: ${{ secrets.A == 'foo' && secrets.B != '' }}\n" },
      ]);
      expect(refs.map((r) => r.name).sort()).toEqual(['A', 'B']);
    });

    it('matches multiple secrets inside a single expression block', () => {
      const refs = findSecretRefs([
        { path: 'a.yml', content: '${{ secrets.PRIMARY || secrets.FALLBACK }}\n' },
      ]);
      expect(refs.map((r) => r.name)).toEqual(['PRIMARY', 'FALLBACK']);
    });

    it('does not match `notsecrets.X` or `mysecrets.X` (word boundary)', () => {
      const refs = findSecretRefs([
        {
          path: 'a.yml',
          content: '${{ notsecrets.A }}\n${{ mysecrets.B }}\n${{ secrets.C }}\n',
        },
      ]);
      expect(refs.map((r) => r.name)).toEqual(['C']);
    });

    it('does not match `secrets.X` outside a ${{ ... }} block', () => {
      const refs = findSecretRefs([
        {
          path: 'a.yml',
          content: '# This is a comment about secrets.FOO bar\n# secrets.BAR also\n${{ secrets.REAL }}\n',
        },
      ]);
      expect(refs.map((r) => r.name)).toEqual(['REAL']);
    });

    it('returns empty array for files with no secret refs', () => {
      const refs = findSecretRefs([{ path: 'a.yml', content: 'name: hello\non: push\n' }]);
      expect(refs).toEqual([]);
    });

    it('returns empty array for empty file list', () => {
      expect(findSecretRefs([])).toEqual([]);
    });
  });

  describe('findMissingSecrets', () => {
    it('reports a ref whose secret is not in the known set', () => {
      const refs = [{ file: 'a.yml', line: 1, name: 'MISSING' }];
      const missing = findMissingSecrets(refs, new Set(['EXISTS']));
      expect(missing).toEqual(refs);
    });

    it('accepts a ref whose secret is in the known set', () => {
      const refs = [{ file: 'a.yml', line: 1, name: 'EXISTS' }];
      const missing = findMissingSecrets(refs, new Set(['EXISTS']));
      expect(missing).toEqual([]);
    });

    it('returns only the missing subset when some refs resolve', () => {
      const refs = [
        { file: 'a.yml', line: 1, name: 'OK' },
        { file: 'a.yml', line: 2, name: 'MISSING1' },
        { file: 'b.yml', line: 5, name: 'OK' },
        { file: 'b.yml', line: 9, name: 'MISSING2' },
      ];
      const missing = findMissingSecrets(refs, new Set(['OK']));
      expect(missing.map((r) => r.name)).toEqual(['MISSING1', 'MISSING2']);
    });

    it('returns empty when known set is empty and refs is empty', () => {
      expect(findMissingSecrets([], new Set())).toEqual([]);
    });

    it('reports all refs as missing when known set is empty', () => {
      const refs = [
        { file: 'a.yml', line: 1, name: 'A' },
        { file: 'a.yml', line: 2, name: 'B' },
      ];
      expect(findMissingSecrets(refs, new Set())).toEqual(refs);
    });

    it('treats secret names case-sensitively (GitHub secrets are uppercase)', () => {
      const refs = [{ file: 'a.yml', line: 1, name: 'FOO' }];
      const missing = findMissingSecrets(refs, new Set(['foo']));
      expect(missing).toEqual(refs);
    });
  });

  describe('parseInheritedAllowlist', () => {
    it('returns empty set for undefined', () => {
      expect(parseInheritedAllowlist(undefined)).toEqual(new Set());
    });

    it('returns empty set for empty string', () => {
      expect(parseInheritedAllowlist('')).toEqual(new Set());
    });

    it('parses a single name', () => {
      expect(parseInheritedAllowlist('FOO')).toEqual(new Set(['FOO']));
    });

    it('parses comma-separated names with whitespace', () => {
      expect(parseInheritedAllowlist('FOO, BAR ,BAZ')).toEqual(
        new Set(['FOO', 'BAR', 'BAZ']),
      );
    });

    it('drops lowercase entries (GitHub secret names are uppercase)', () => {
      expect(parseInheritedAllowlist('FOO,bar,Baz')).toEqual(new Set(['FOO']));
    });

    it('drops entries with disallowed characters', () => {
      expect(parseInheritedAllowlist('FOO,BAR-X,BAZ.Y,QUX')).toEqual(
        new Set(['FOO', 'QUX']),
      );
    });

    it('accepts digits and underscores', () => {
      expect(parseInheritedAllowlist('FOO_2,BAR_API_KEY')).toEqual(
        new Set(['FOO_2', 'BAR_API_KEY']),
      );
    });
  });
});
