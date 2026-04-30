/**
 * Record description builders and field extractors for sourcing.
 * Converts raw API record objects into human-readable descriptions and typed field maps.
 */

import type { RecordType } from '../../../apps/wiki-server/src/api-types.ts';
import { str, strOrNull, numOrNull, resolveName } from './record-fields.ts';

export function buildRecordDescription(recordType: RecordType, item: Record<string, unknown>): string {
  switch (recordType) {
    case 'grant': {
      const funder = resolveName(item, 'orgResolvedName', 'orgDisplayName', 'organizationId');
      const grantee = resolveName(item, 'granteeResolvedName', 'granteeDisplayName', 'granteeId');
      return `Grant: ${str(item, 'name')} (${funder} -> ${grantee})`;
    }
    case 'personnel': {
      const person = resolveName(item, 'personResolvedName', 'personDisplayName', 'personId');
      const org = resolveName(item, 'orgResolvedName', 'orgDisplayName', 'organizationId');
      return `Personnel: ${person} at ${org} (${str(item, 'role')})`;
    }
    case 'division':
      return `Division: ${str(item, 'name')}`;
    case 'funding-program':
      return `Funding Program: ${str(item, 'name')}`;
    case 'funding-round': {
      const company = resolveName(item, 'companyResolvedName', 'companyDisplayName', 'companyId');
      return `Funding Round: ${str(item, 'name')} (${company})`;
    }
    case 'investment': {
      const investor = resolveName(item, 'investorResolvedName', 'investorDisplayName', 'investorId');
      const company = resolveName(item, 'companyResolvedName', 'companyDisplayName', 'companyId');
      return `Investment: ${investor} -> ${company}`;
    }
    case 'equity-position': {
      const holder = resolveName(item, 'holderResolvedName', 'holderDisplayName', 'holderId');
      const company = resolveName(item, 'companyResolvedName', 'companyDisplayName', 'companyId');
      return `Equity: ${holder} in ${company}`;
    }
    case 'policy-stakeholder': {
      const name = resolveName(item, 'stakeholderResolvedName', 'stakeholderDisplayName', 'stakeholderId');
      return `Stakeholder: ${name} (${strOrNull(item, 'stance') ?? 'unknown'})`;
    }
    case 'publication': {
      const title = str(item, 'title');
      const authors = strOrNull(item, 'authors') ?? 'unknown authors';
      const year = strOrNull(item, 'publishedDate') ?? 'unknown year';
      return `Publication: ${title} by ${authors} (${year})`;
    }
    case 'benchmark-result': {
      const benchmarkId = str(item, 'benchmarkId');
      const modelId = str(item, 'modelId');
      const score = numOrNull(item, 'score');
      return `Benchmark Result: ${modelId} on ${benchmarkId} = ${score ?? 'N/A'}`;
    }
    case 'entity-event': {
      const title = str(item, 'title');
      const eventType = strOrNull(item, 'eventType') ?? 'unknown';
      const date = strOrNull(item, 'date') ?? 'unknown date';
      return `Entity Event: ${title} (${eventType}, ${date})`;
    }
    case 'entity-assessment': {
      const dimension = str(item, 'dimension');
      const rating = str(item, 'rating');
      const entityId = strOrNull(item, 'entityId') ?? 'unknown';
      return `Assessment: ${entityId} / ${dimension} = ${rating}`;
    }
    case 'secondary-market-price': {
      const company = resolveName(item, 'companyResolvedName', 'companyDisplayName', 'companyId');
      const platform = str(item, 'platform');
      const date = strOrNull(item, 'date') ?? 'unknown date';
      const valuation = numOrNull(item, 'impliedValuation');
      const valuationStr = valuation != null ? ` ($${(valuation / 1e9).toFixed(1)}B)` : '';
      return `Market Price: ${company} on ${platform} (${date})${valuationStr}`;
    }
    case 'ai-model': {
      // QUA-685: items are flattened from /api/entities/export rows — the
      // model's title is the entity title, fields live alongside.
      const title = strOrNull(item, 'title') ?? str(item, 'id');
      const developer = strOrNull(item, 'developer');
      return developer ? `AI Model: ${title} (${developer})` : `AI Model: ${title}`;
    }
    default:
      return `${recordType}: ${strOrNull(item, 'name') ?? strOrNull(item, 'title') ?? 'unknown'}`;
  }
}

export function extractRecordFields(recordType: RecordType, item: Record<string, unknown>): Record<string, string | number | null> {
  switch (recordType) {
    case 'grant':
      return {
        name: str(item, 'name'),
        amount: numOrNull(item, 'amount'),
        date: strOrNull(item, 'date'),
        grantee: resolveName(item, 'granteeResolvedName', 'granteeDisplayName', 'granteeId'),
        funder: resolveName(item, 'orgResolvedName', 'orgDisplayName', 'organizationId'),
      };
    case 'personnel':
      return {
        person: resolveName(item, 'personResolvedName', 'personDisplayName', 'personId'),
        org: resolveName(item, 'orgResolvedName', 'orgDisplayName', 'organizationId'),
        role: str(item, 'role'),
        startDate: strOrNull(item, 'startDate'),
        endDate: strOrNull(item, 'endDate'),
      };
    case 'division':
      return { name: str(item, 'name'), type: str(item, 'divisionType'), status: str(item, 'status') };
    case 'funding-program':
      return { name: str(item, 'name'), budget: numOrNull(item, 'totalBudget'), status: strOrNull(item, 'status') };
    case 'funding-round':
      return { name: str(item, 'name'), raised: numOrNull(item, 'raised'), valuation: numOrNull(item, 'valuation'), date: strOrNull(item, 'date') };
    case 'investment':
      return { amount: numOrNull(item, 'amount'), round: strOrNull(item, 'roundName'), role: strOrNull(item, 'role') };
    case 'equity-position':
      return { stake: strOrNull(item, 'stake'), asOf: strOrNull(item, 'asOf') };
    case 'policy-stakeholder':
      return { stance: strOrNull(item, 'stance'), role: strOrNull(item, 'role') };
    case 'publication':
      return {
        title: str(item, 'title'),
        authors: strOrNull(item, 'authors'),
        publishedDate: strOrNull(item, 'publishedDate'),
        url: strOrNull(item, 'url'),
        venue: strOrNull(item, 'venue'),
        publicationType: strOrNull(item, 'publicationType'),
      };
    case 'benchmark-result':
      return {
        benchmarkId: str(item, 'benchmarkId'),
        modelId: str(item, 'modelId'),
        score: numOrNull(item, 'score'),
        unit: strOrNull(item, 'unit'),
        date: strOrNull(item, 'date'),
      };
    case 'entity-event':
      return {
        title: str(item, 'title'),
        eventType: str(item, 'eventType'),
        date: strOrNull(item, 'date'),
        entityId: strOrNull(item, 'entityId'),
        significance: strOrNull(item, 'significance'),
      };
    case 'entity-assessment':
      return {
        entityId: strOrNull(item, 'entityId'),
        dimension: str(item, 'dimension'),
        rating: str(item, 'rating'),
        assessor: strOrNull(item, 'assessor'),
        assessedAt: strOrNull(item, 'assessedAt'),
      };
    case 'secondary-market-price':
      return {
        company: resolveName(item, 'companyResolvedName', 'companyDisplayName', 'companyId'),
        platform: str(item, 'platform'),
        date: strOrNull(item, 'date'),
        impliedValuation: numOrNull(item, 'impliedValuation'),
        pricePerShare: numOrNull(item, 'pricePerShare'),
        priceType: strOrNull(item, 'priceType'),
      };
    case 'ai-model':
      // QUA-685: the five scalar fields the LLM should verify against the
      // model's release announcement / pricing page. Other fields like
      // benchmarks[] have inline sources and are sourced separately.
      return {
        title: strOrNull(item, 'title') ?? str(item, 'id'),
        developer: strOrNull(item, 'developer'),
        releaseDate: strOrNull(item, 'releaseDate'),
        inputPrice: numOrNull(item, 'inputPrice'),
        outputPrice: numOrNull(item, 'outputPrice'),
        contextWindow: numOrNull(item, 'contextWindow'),
        safetyLevel: strOrNull(item, 'safetyLevel'),
      };
    default:
      return { name: strOrNull(item, 'name') ?? strOrNull(item, 'title') };
  }
}
