## 2026-02-18 | claude/integrate-grokepedia-gKpMf | Integrate Grokipedia as external link platform

**What was done:** Added Grokipedia as a 9th external link platform with 79 verified page mappings. Full integration across data types, UI (InfoBox), CLI tooling (`crux grokipedia match`), content pipeline (canonical-links, source-fetching, scan-content, resource-utils), and verification scripts. Fixed shell injection vulnerability in curl-based URL checkers (execSync -> execFileSync). Removed 89 broken links via HEAD verification + 3 semantic mismatches (conjecture/mesa-optimization/chain-of-thought pointed to wrong articles).

**Pages:** grokipedia

**Issues encountered:**
- DNS resolution blocked in this environment (`EAI_AGAIN`) for Node.js https; curl works as fallback
- Title-based matching produced ~52% false positive rate (89/171 broken); curl HEAD verification was essential
- `conjecture` mapped to math concept instead of AI safety org; `mesa-optimization` and `chain-of-thought` mapped to parent topics

**Learnings/notes:**
- Always verify Grokipedia links via HEAD requests; title-based matching is unreliable for niche topics
- Use `execFileSync` (not `execSync`) when passing external data to shell commands to prevent injection
- Grokipedia URL pattern: `https://grokipedia.com/page/Article_Name` (Wikipedia-style slugs)
- Created GitHub Issue #209 for future Option C: using Grokipedia as research source in content pipeline
