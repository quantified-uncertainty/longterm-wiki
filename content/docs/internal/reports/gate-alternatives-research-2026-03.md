# Gate Validation Alternatives Research (March 2026)

Research into off-the-shelf tools that could replace or complement the `crux validate gate` system.

## Current System Summary

`crux validate gate` orchestrates 6 CI-blocking validators (comparison-operators, dollar-signs, schema, frontmatter-schema, numeric-id-integrity, prefer-entitylink) plus advisory checks. Unique features:

- **Mixed-domain validation**: MDX content + YAML schema + frontmatter + code in one system
- **Unified --fix**: Content escaping, markdown fixes, schema fixes all in one workflow
- **LLM-based triage**: Skips irrelevant validators based on changed files
- **Wiki-specific checks**: EntityLink enforcement, MDX escaping — no off-the-shelf tool handles these

No single tool replaces this. The evaluation focuses on what could **complement** the gate.

## Tools Evaluated

### Tier 1: Likely Win

#### Reviewdog — Inline PR annotations for gate results

- **What**: Universal adapter that takes linter/validator output and posts inline comments on PR diffs
- **Benefit**: Gate failures currently require reading CI logs. Reviewdog would show the exact MDX line with the escaping error directly in the PR diff
- **Effort**: ~2-4 hours. Add checkstyle/JSON output to gate, add reviewdog GitHub Action step
- **Sentiment**: Positive. 9K+ GitHub stars, actively maintained, lightweight Go binary
- **Risk**: Low. Purely additive — doesn't replace anything
- **Caveats**:
  - **Supply chain attack (March 2025)**: `reviewdog/action-setup@v1` was compromised (CVE-2025-30154), exfiltrating CI secrets from 218 repos. Mitigation: SHA-pin all reviewdog actions instead of using mutable tags
  - **Exit code handling**: `--fail-on-error` has known reliability issues — exit codes can be swallowed silently. Needs careful testing with `--fail-level`
  - **Custom errorformat**: When gate output doesn't match a pre-defined format, custom errorformat strings fail silently (no "unmatched lines" warning). Better to output checkstyle XML from the gate directly
  - **Fork PR limitations**: PRs from forks can't use `github-pr-review` reporter due to `GITHUB_TOKEN` scope (GitHub limitation, not reviewdog-specific)
- **Main concern**: Gate output needs a parseable format (checkstyle XML or custom errorformat). Currently stdout-only. Checkstyle XML is the safer path — avoids silent errorformat failures
- **Verdict**: Best ROI despite caveats. Particularly valuable for content authors reviewing MDX changes. SHA-pin actions and output checkstyle XML to avoid the two main pitfalls

### Tier 2: Worth Evaluating

#### Biome — Fast Rust-based linter + formatter

- **What**: Replaces ESLint + Prettier. 20-100x faster. 340+ rules. Single tool, single config
- **Sentiment**: Very positive. 2M+ weekly npm downloads. Active development (Biome 2.0 adds GritQL custom rules)
- **Benefit**: Speed improvement in CI for TS/TSX linting. Eliminates ESLint+Prettier config complexity
- **Limitations**: No MDX support. No Tailwind-specific rules equivalent. Doesn't help with any custom gate validators
- **Verdict**: Only worth it if ESLint/Prettier is a pain point today. Solves a different problem than the gate

#### Knip — Dead code / unused exports detection

- **What**: Finds unused files, exports, and dependencies. Has `--changed --base main` for CI
- **Sentiment**: Very positive. 7K+ stars. Actively maintained. Next.js plugin included
- **Limitations**: High false-positive risk with 700+ MDX files and YAML→database.json pipeline. Doesn't understand custom content pipeline
- **Verdict**: Run `npx knip` once to see what it finds. If useful, add to CI. If noisy, skip

### Tier 3: Not a Win Right Now

#### Lefthook — Git hooks manager
- **Why skip**: Gate runs in CI, not as git hooks. Already have `.githooks/` and Claude Code hooks. Switching is pure overhead
- **Note**: Good tool (used by GitLab, Discourse), just not solving a problem we have

#### Danger.js — Programmable PR automation
- **Why skip**: Declining maintenance (last major release 2023, 0 releases in 2026). ESM incompatibility is a major unresolved issue (#1180, open since 2021). `actions/github-script` does 80% of what it offers. `crux pr` commands already cover our PR automation needs

#### Nx / Turborepo — Monorepo build orchestration
- **Why skip**: Our monorepo is small (3 workspaces). These tools shine at 10+ packages

#### MegaLinter / Super-Linter — Meta-linters
- **Why skip**: Docker-based, slow, linter-focused. Can't run domain-specific validators (EntityLink, MDX escaping, frontmatter schema)

## Recommendation

**Start with Reviewdog.** Implementation plan:

1. Add `--format=checkstyle` output option to `crux validate gate` (avoids fragile custom errorformat)
2. Add a reviewdog step to the GitHub Actions validation workflow, **SHA-pinned** (not tag-pinned)
3. Configure `filter_mode: added` to only annotate changed lines in PRs
4. Test `--fail-on-error --fail-level=error` to ensure gate failures still block merges

This is ~2-4 hours of work, low risk, and immediately improves the experience of reviewing content PRs with validation errors.

Everything else is either "nice to have" (Biome, Knip) or "not needed" (Lefthook, Danger.js, Nx).

## Sources

- [Reviewdog GitHub](https://github.com/reviewdog/reviewdog) — 9K+ stars, active maintenance
- [Reviewdog supply chain attack (Wiz)](https://www.wiz.io/blog/new-github-action-supply-chain-attack-reviewdog-action-setup) — CVE-2025-30154
- [Reviewdog filter settings guide](https://lornajane.net/posts/2024/reviewdog-filter-settings-with-github-actions) — practical walkthrough
- [Biome](https://biomejs.dev/) — 2M+ weekly downloads, Biome 2.0 released 2025
- [Knip](https://knip.dev/) — 7K+ stars, 500K+ weekly downloads
- [Lefthook](https://github.com/evilmartians/lefthook) — 7.5K stars, used by GitLab
- [Danger.js](https://danger.systems/js/) — declining maintenance since 2023
- [pre-commit](https://pre-commit.com/) / [prek](https://github.com/j178/prek) — hook managers
- [MegaLinter](https://megalinter.io/) — Docker-based meta-linter
