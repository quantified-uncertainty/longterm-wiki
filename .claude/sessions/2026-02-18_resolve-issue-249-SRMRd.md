## 2026-02-18 | claude/resolve-issue-249-SRMRd | Fix O(n²) algorithms in build pipeline

**What was done:** Fixed three O(n²) performance bottlenecks in the build pipeline: (1) replaced O(n²) entity name-prefix matching with O(n log n) sorted-scan approach, (2) added contentFormat-based clustering to redundancy analysis to eliminate cross-format comparisons, (3) replaced O(n) `entities.find()` calls in statistics with a pre-built Map for O(1) lookups.

**Model:** opus-4-6

**Duration:** ~15min

**Issues encountered:**
- None

**Learnings/notes:**
- The name-prefix matching optimization relies on `-` being the lowest ASCII character in entity ID slugs (lower than digits and letters), guaranteeing prefix matches are contiguous in sorted order.
