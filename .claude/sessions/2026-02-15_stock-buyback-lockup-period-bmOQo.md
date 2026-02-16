## 2026-02-15 | claude/stock-buyback-lockup-period-bmOQo | Add employee lockup period analysis

**What was done:** Added a dedicated "Employee Lockup Period Implications" subsection to the Anthropic Investors (E406) page under the IPO Timeline section. The page previously mentioned lockup periods only in passing (3 brief mentions). The new section covers: standard lockup structures and staged expirations, impact on employee donation pledges and DAF liquidity, stock price risk during lockup, the March 2025 buyback as partial mitigation, and secondary market restrictions for employees. Also ran crux content improve pipeline which restructured the page (footnote citations, cleaner formatting) and restored truncated content from the pipeline output.

**Pages:** anthropic-investors

**Issues encountered:**
- `pnpm crux` command failed (workspace resolution issue); had to invoke via `node --import tsx/esm crux/crux.mjs` directly
- Crux content improve pipeline research phase hit tool turn limit (10) after 18 minutes, finding 0 sources
- Pipeline truncated the file at line 775 (original was 844 lines), cutting off mid-sentence in "Differential Impact by Cause" section — had to manually restore ~70 lines of content
- Pipeline did not add the requested lockup subsection despite detailed directions — had to add manually
- Pipeline introduced double-escaped dollar signs (`\\$`) and unescaped `$` in footnote text

**Learnings/notes:**
- The crux improve pipeline can truncate long pages — always diff against the original to check for lost content
- For targeted additions to specific sections, manual editing may be more reliable than the improve pipeline
- The `--directions` flag may not be reliably parsed (error: `directions.slice is not a function`)
