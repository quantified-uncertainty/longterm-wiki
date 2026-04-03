/**
 * Resource Enrichment — PDF Archival to DigitalOcean Spaces
 *
 * Downloads PDF resource files and uploads them to DO Spaces for
 * permanent archival. Especially important for PDFs on dead/at-risk
 * domains (fhi.ox.ac.uk, intelligence.org, etc.).
 *
 * Spaces URL pattern: resources/pdfs/{resource-id}.pdf
 * Public URL: https://quri-longtermwiki.nyc3.digitaloceanspaces.com/resources/pdfs/{id}.pdf
 *
 * Env vars required:
 *   SPACES_ENDPOINT    (https://nyc3.digitaloceanspaces.com)
 *   SPACES_BUCKET      (quri-longtermwiki)
 *   SPACES_ACCESS_KEY
 *   SPACES_SECRET_KEY
 *
 * Usage:
 *   pnpm crux resources archive-pdfs --dry-run
 *   pnpm crux resources archive-pdfs --limit=50
 *   pnpm crux resources archive-pdfs --at-risk-only
 *   pnpm crux resources archive-pdfs --verbose
 */

import { S3Client, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { loadResourcesPGFirst } from '../resource-io.ts';
import { sleep } from '../resource-utils.ts';
import type { CommandResult } from '../lib/cli.ts';

// ── Configuration ────────────────────────────────────────────────────────────

const SPACES_ENDPOINT = process.env.SPACES_ENDPOINT || 'https://nyc3.digitaloceanspaces.com';
const SPACES_BUCKET = process.env.SPACES_BUCKET || 'quri-longtermwiki';
const SPACES_REGION = 'nyc3';
const KEY_PREFIX = 'resources/pdfs';
const FETCH_TIMEOUT_MS = 30_000;
const MAX_PDF_SIZE = 50 * 1024 * 1024; // 50MB safety limit

/** Domains known to be dead or at high risk of disappearing. */
const AT_RISK_DOMAINS = new Set([
  'www.fhi.ox.ac.uk', 'fhi.ox.ac.uk',
  'intelligence.org', 'www.intelligence.org',
  'ftxfuturefund.org', 'www.ftxfuturefund.org',
  'safesecureai.org', 'www.safesecureai.org',
  'maliciousaireport.com', 'www.maliciousaireport.com',
  'aigi.ox.ac.uk',
]);

// ── S3 Client ────────────────────────────────────────────────────────────────

function createS3Client(): S3Client {
  const accessKey = process.env.SPACES_ACCESS_KEY;
  const secretKey = process.env.SPACES_SECRET_KEY;

  if (!accessKey || !secretKey) {
    throw new Error(
      'SPACES_ACCESS_KEY and SPACES_SECRET_KEY must be set.\n' +
      'These are in the longtermwiki-spaces-env K8s secret.\n' +
      'Add them to your .env for local usage.',
    );
  }

  return new S3Client({
    endpoint: SPACES_ENDPOINT,
    region: SPACES_REGION,
    credentials: {
      accessKeyId: accessKey,
      secretAccessKey: secretKey,
    },
    forcePathStyle: false, // DO Spaces uses virtual-hosted style
  });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function spacesKey(resourceId: string): string {
  return `${KEY_PREFIX}/${resourceId}.pdf`;
}

function publicUrl(resourceId: string): string {
  return `https://${SPACES_BUCKET}.${SPACES_REGION}.digitaloceanspaces.com/${spacesKey(resourceId)}`;
}

async function objectExists(client: S3Client, key: string): Promise<boolean> {
  try {
    await client.send(new HeadObjectCommand({ Bucket: SPACES_BUCKET, Key: key }));
    return true;
  } catch {
    return false;
  }
}

async function downloadPdf(url: string): Promise<{ buffer: ArrayBuffer; size: number } | null> {
  try {
    // Try direct URL first
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; LongtermWikiBot/1.0; +https://www.longtermwiki.com)',
        Accept: 'application/pdf,*/*',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!response.ok) {
      // Try Wayback Machine fallback for dead sites
      const waybackUrl = `https://web.archive.org/web/${new Date().getFullYear()}/${url}`;
      const wbResponse = await fetch(waybackUrl, {
        redirect: 'follow',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!wbResponse.ok) return null;

      const buffer = await wbResponse.arrayBuffer();
      if (buffer.byteLength > MAX_PDF_SIZE) return null;
      return { buffer, size: buffer.byteLength };
    }

    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > MAX_PDF_SIZE) return null;

    // Verify it's actually a PDF (starts with %PDF)
    const header = new Uint8Array(buffer.slice(0, 5));
    const headerStr = String.fromCharCode(...header);
    if (!headerStr.startsWith('%PDF')) {
      // Might be an HTML error page
      return null;
    }

    return { buffer, size: buffer.byteLength };
  } catch {
    return null;
  }
}

// ── Main command ─────────────────────────────────────────────────────────────

export async function archivePdfsCommand(
  args: string[],
  options: Record<string, unknown>,
): Promise<CommandResult> {
  const limit = (options.limit as number) || 200;
  const dryRun = !!(options['dry-run'] || options.dryRun);
  const verbose = options.verbose as boolean;
  const atRiskOnly = options['at-risk-only'] as boolean;
  const concurrency = (options.concurrency as number) || 3;

  console.log(`📦 PDF Archival to DigitalOcean Spaces${dryRun ? ' (DRY RUN)' : ''}\n`);
  console.log(`  Bucket: ${SPACES_BUCKET}`);
  console.log(`  Endpoint: ${SPACES_ENDPOINT}\n`);

  let client: S3Client | null = null;
  if (!dryRun) {
    client = createS3Client();
  }

  const resources = await loadResourcesPGFirst();

  // Find PDF resources
  const pdfResources = resources.filter((r) => {
    if (!r.url) return false;
    if (!r.url.endsWith('.pdf')) return false;
    if (atRiskOnly) {
      try {
        const hostname = new URL(r.url).hostname;
        return AT_RISK_DOMAINS.has(hostname);
      } catch {
        return false;
      }
    }
    return true;
  });

  console.log(`  Found ${pdfResources.length} PDF resources${atRiskOnly ? ' (at-risk domains only)' : ''}`);

  // Check which are already archived (skip if already in Spaces)
  const toArchive = [];
  if (!dryRun && client) {
    console.log('  Checking which are already archived...');
    for (const r of pdfResources) {
      const exists = await objectExists(client, spacesKey(r.id));
      if (!exists) toArchive.push(r);
    }
    console.log(`  ${pdfResources.length - toArchive.length} already archived, ${toArchive.length} to archive`);
  } else {
    toArchive.push(...pdfResources);
  }

  const toProcess = toArchive.slice(0, limit);

  if (toProcess.length === 0) {
    console.log('\n  ✅ All PDFs already archived');
    return { exitCode: 0, output: 'All PDFs archived' };
  }

  console.log(`\n  Archiving ${toProcess.length} PDFs (concurrency: ${concurrency})...\n`);

  let archived = 0;
  let failed = 0;
  let skipped = 0;
  let idx = 0;

  async function worker(): Promise<void> {
    while (idx < toProcess.length) {
      const i = idx++;
      const r = toProcess[i];

      // Download PDF
      const result = await downloadPdf(r.url);
      if (!result) {
        failed++;
        if (verbose) console.log(`  ✗ Download failed: ${r.title || r.url}`);
        await sleep(200);
        continue;
      }

      if (dryRun) {
        archived++;
        if (verbose) {
          console.log(`  ✓ Would archive: ${r.title || r.url} (${(result.size / 1024).toFixed(0)}KB)`);
        }
        await sleep(100);
        continue;
      }

      // Upload to Spaces
      try {
        await client!.send(new PutObjectCommand({
          Bucket: SPACES_BUCKET,
          Key: spacesKey(r.id),
          Body: new Uint8Array(result.buffer),
          ContentType: 'application/pdf',
          ACL: 'public-read',
          Metadata: {
            'original-url': r.url,
            'resource-title': (r.title || '').slice(0, 200),
            'archived-at': new Date().toISOString(),
          },
        }));
        archived++;
        if (verbose) {
          console.log(`  ✓ Archived: ${r.title || r.url} (${(result.size / 1024).toFixed(0)}KB) → ${publicUrl(r.id)}`);
        }
      } catch (err) {
        failed++;
        if (verbose) {
          console.log(`  ✗ Upload failed: ${r.title || r.url}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      if ((archived + failed) % 10 === 0) {
        process.stdout.write(`\r  Progress: ${archived + failed + skipped}/${toProcess.length} (${archived} archived)`);
      }

      await sleep(300); // Be polite to source servers
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, toProcess.length) },
    () => worker(),
  );
  await Promise.all(workers);

  console.log(`\n\n  Results:`);
  console.log(`    Archived:  ${archived}`);
  console.log(`    Failed:    ${failed}`);
  console.log(`    Skipped:   ${skipped}`);

  if (archived > 0 && !dryRun) {
    console.log(`\n  PDFs available at: https://${SPACES_BUCKET}.${SPACES_REGION}.digitaloceanspaces.com/${KEY_PREFIX}/`);
  }

  return { exitCode: 0, output: `Archived ${archived} PDFs` };
}
