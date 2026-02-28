/**
 * Tool: audit_citations
 *
 * Verifies all citations on the page against their source URLs.
 * Cost: ~$0.20.
 */

import { auditCitations, type AuditRequest } from '../../../lib/citation-auditor.ts';
import type { ToolRegistration } from './types.ts';

export const tool: ToolRegistration = {
  name: 'audit_citations',
  cost: 0.20,
  definition: {
    name: 'audit_citations',
    description:
      'Verify all citations on the current page against their source URLs. Returns per-citation verdicts (verified, unsupported, misattributed, url-dead). Use after rewriting to check citation quality. Cost: $0.10-0.30.',
    input_schema: {
      type: 'object' as const,
      properties: {},
      required: [],
    },
  },
  createHandler: (ctx) => async () => {
    try {
      const request: AuditRequest = {
        content: ctx.currentContent,
        fetchMissing: true,
        passThreshold: 0.7,
      };

      const result = await auditCitations(request);
      ctx.citationAudit = result.citations;

      return JSON.stringify(
        {
          total: result.summary.total,
          verified: result.summary.verified,
          failed: result.summary.failed,
          misattributed: result.summary.misattributed,
          unchecked: result.summary.unchecked,
          unsourcedTableCells: result.summary.unsourcedTableCells,
          pass: result.pass,
          failedCitations: result.citations
            .filter((c) => c.verdict === 'unsupported' || c.verdict === 'misattributed')
            .map((c) => ({
              footnoteRef: c.footnoteRef,
              claim: c.claim.slice(0, 100),
              verdict: c.verdict,
              explanation: c.explanation,
              sourceContext: c.sourceContext,
            })),
          ...(result.unsourcedTableCells.length > 0
            ? {
                unsourcedTableCellDetails: result.unsourcedTableCells.map((cell) => ({
                  line: cell.line,
                  column: cell.column,
                  cellText: cell.cellText.slice(0, 80),
                })),
              }
            : {}),
        },
        null,
        2,
      );
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      return JSON.stringify({ error: `Citation audit failed: ${error.message}` });
    }
  },
};
