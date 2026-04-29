# ADR-0005: Content quality and staleness governance

## Status

`Charter`

## Context

The wiki has 763 MDX pages and 571 FactBase entities. Content is edited by:

- Auto-update pipelines (mostly disabled; `auto-update.yml` is `workflow_dispatch`-only per QUA-31)
- Crux improve runs (`crux w improve <id> --apply`)
- Agent sessions on specific tickets
- Occasional human edits

Source-check verdicts (`source_check_verdicts` table) measure citation accuracy at the per-claim level. Coverage scores measure depth per entity (1-4 scale). Citation accuracy dashboards exist (E917, E918, E919). But:

- There's no clear policy on **when a page needs human review** vs. agent-only edits
- Trends over time aren't surfaced — is content quality improving or declining?
- "Staleness" is implicit (no tracked metric)
- The auto-update cron is disabled (QUA-31) but the underlying question of "should this run autonomously" was never decided

The wiki's value depends on content quality. Operating without an explicit policy is a long-run risk.

## Question

What's the right governance model for wiki content quality, citation accuracy, and freshness in a codebase where most edits are made by AI agents?

Specifically:

1. When can agents edit autonomously? When must they hand off to a human?
2. What's the quality / staleness metric we actually care about?
3. How do we measure trends over time?
4. Should auto-update pipelines be re-enabled, kept disabled, or restructured?

## What counts as a decision

A content governance policy with:

- **Autonomy tiers** — what kinds of edits agents can make alone vs. what requires human review
- **Quality metrics** — which existing or new metrics are the load-bearing ones
- **Staleness policy** — what triggers a re-review (time-since-edit, source-check verdict change, source content change, etc.)
- **Auto-update decision** — re-enable, keep disabled, or restructure
- **Measurement infrastructure** — what dashboards or trend lines need to exist

## In scope

- Audit current quality metrics (coverage scores, source-check verdicts, citation accuracy, hallucination risk)
- Distribution of last-edited dates across pages
- Edit-rate per page, broken down by editor type (agent vs. human)
- Staleness analysis — pages cited heavily but not edited in 6+ months
- Survey of similar projects for content governance patterns
- Cost of building the trend-line infrastructure if not present

## Out of scope

- Actually building the dashboards (downstream tickets in Dashboards & Visibility)
- Re-enabling specific pipelines (downstream tickets in Automation & Infrastructure)
- Wiki content edits themselves

## Time-box

5 working days from charter to decision.

## Success criteria

ADR ends with a written content quality policy + a list of measurements that need to exist. A "current state is fine" outcome is acceptable but should be defended with current metric trends, not assumption.
