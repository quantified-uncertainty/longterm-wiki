import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Methodology | Frontier Safety Frameworks",
  description:
    "How frontier safety framework thresholds are extracted, how diffs between versions are classified, and what the review states mean.",
};

export default function MethodologyPage() {
  return (
    <article className="container max-w-3xl mx-auto px-4 py-8 prose prose-neutral dark:prose-invert">
      <nav className="text-xs text-muted-foreground not-prose mb-3">
        <Link href="/frontier-safety-frameworks" className="hover:text-primary">
          ← Frontier Safety Frameworks
        </Link>
      </nav>

      <h1>Methodology</h1>

      <p className="lead">
        This tracker mirrors versioned safety commitments from frontier AI
        labs — Responsible Scaling Policies, Preparedness Frameworks, and
        Frontier Safety Frameworks. Capability thresholds are
        LLM-extracted from each version, grounded in source quotes, and
        cross-version diffs are classified before any directional summary is
        shown publicly.
      </p>

      <h2>Threshold extraction</h2>

      <p>
        For each published framework version, an LLM (Claude or GPT-class
        model) reads the source document and extracts capability tiers. Each
        extracted threshold row carries:
      </p>

      <ul>
        <li>
          <strong>Canonical risk domain</strong> — one of CBRN, bio, chem,
          nuclear, radiological, cyber, autonomy & replication, AI R&amp;D,
          scheming, persuasion, loss-of-control, or other. This normalized
          domain enables cross-lab comparison; the lab&apos;s native domain
          label is preserved separately.
        </li>
        <li>
          <strong>Tier label and severity</strong> — the lab&apos;s own tier
          name (e.g., &quot;ASL-3&quot;, &quot;High&quot;) plus a 1–5 sort
          order so cells can be color-coded uniformly across labs.
        </li>
        <li>
          <strong>Trigger description</strong> — the capability that activates
          the tier.
        </li>
        <li>
          <strong>Source quote</strong> — mandatory. Every row must cite a
          quoted span from the source document. Rows without a verbatim
          source quote are rejected at extraction time.
        </li>
        <li>
          <strong>Commitment language tag</strong> — committed, aspirational,
          conditional, or informational. Distinguishes binding promises from
          forward-looking statements.
        </li>
      </ul>

      <p>
        Each row is then optionally human-reviewed. Reviewed rows show a
        green &quot;Reviewed&quot; pill; pending rows show an amber
        &quot;Pending&quot; pill in the threshold matrix.
      </p>

      <h2>Diff classification</h2>

      <p>
        When a new version supersedes the previous one, an LLM compares the
        two versions and produces both an aggregate{" "}
        <code>framework_diffs</code> row and per-change{" "}
        <code>framework_diff_items</code> rows. Each item is tagged as one of:
        threshold added/removed, mitigation softened/strengthened, commitment
        weakened/strengthened, scope narrowed/broadened, eval changed,
        clarification, or other.
      </p>

      <p>
        Each diff also carries an <code>overall_direction</code> from the
        classifier (weaker, stronger, mixed, neutral, or rewrite) — but{" "}
        <strong>that classification is never displayed publicly until a human
        reviewer confirms it.</strong>
      </p>

      <h2>Review states</h2>

      <p>Public diffs are gated on the <code>review_verdict</code> column:</p>

      <ul>
        <li>
          <strong>Confirmed weakening / strengthening</strong> — a reviewer
          has read the diff items, agrees with the classifier&apos;s direction,
          and surfaced a directional badge.
        </li>
        <li>
          <strong>Nuanced</strong> — the change is significant but
          directionally ambiguous (e.g., one threshold weakened, another
          strengthened); displayed with an amber &quot;Nuanced&quot; badge
          and the reviewer&apos;s notes.
        </li>
        <li>
          <strong>False positive</strong> — the classifier flagged a change
          but a human determined it&apos;s editorial / non-substantive. No
          directional badge is shown.
        </li>
        <li>
          <strong>Pending review</strong> — the diff exists but has not been
          reviewer-confirmed. The factual change list is shown, but no
          directional summary like &quot;weakened&quot; or
          &quot;strengthened&quot; ever appears for an unreviewed diff.
        </li>
      </ul>

      <p>
        This gating is intentional. Saying a lab &quot;weakened&quot; its
        commitments is a non-trivial editorial judgment; we want a human to
        endorse that framing before showing it on the public page.
      </p>

      <h2>Source preservation</h2>

      <p>
        Every ingested version captures both the live source URL and an
        archived snapshot (Wayback Machine + PDF where applicable), so silent
        edits to the underlying document don&apos;t lose evidence. Content is
        normalized and SHA-256 hashed; whitespace-only changes don&apos;t
        register as new versions, but any substantive textual change does.
      </p>

      <h2>Limitations</h2>

      <ul>
        <li>
          The canonical risk-domain mapping is opinionated; some lab-native
          categories don&apos;t map cleanly (e.g., a single lab&apos;s
          &quot;model autonomy&quot; tier may straddle{" "}
          <em>autonomy &amp; replication</em>, <em>AI R&amp;D</em>, and{" "}
          <em>scheming</em>). The original lab-native label is preserved on
          every threshold row.
        </li>
        <li>
          Tier sort order is normalized 1–5 across labs but is{" "}
          <strong>not</strong> a calibrated severity scale. A &quot;tier-3&quot;
          at one lab is not directly comparable to &quot;tier-3&quot; at
          another — the matrix view helps spot which labs cover which
          domains, not which lab&apos;s thresholds are objectively stricter.
        </li>
        <li>
          Diff classification uses the LLM that extracted thresholds — if the
          extraction missed a row, the diff classifier won&apos;t see it
          either.
        </li>
      </ul>

      <h2>Schema and code</h2>

      <p>
        Schema, sync routes, and ingest pipeline land under tickets QUA-691
        (foundation), QUA-707 (ingest 12 frameworks), QUA-709 (this UI), and
        QUA-710 (internal review dashboard). The PG schema is in{" "}
        <code>apps/wiki-server/src/schema.ts</code> under the QUA-691 Phase 4
        section.
      </p>

      <p className="not-prose text-xs text-muted-foreground mt-8">
        <Link href="/frontier-safety-frameworks" className="underline hover:text-primary">
          ← Back to all frameworks
        </Link>
      </p>
    </article>
  );
}
