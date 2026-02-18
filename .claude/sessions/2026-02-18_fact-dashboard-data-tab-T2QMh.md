## 2026-02-18 | claude/fact-dashboard-data-tab-T2QMh | Add Data tab to Fact Dashboard

**What was done:** Added a "Data" tab to the Fact Dashboard (`/internal/facts`) with a flat, sortable, filterable, paginated TanStack table showing all fact fields. The existing dashboard views (By Entity, By Measure, Timeseries) are now under a "Dashboard" tab. Also exposed additional fact fields (subject, format, formatDivisor, noCompute) from the server component.

**Model:** opus-4-6

**Duration:** ~20min

**Issues encountered:**
- None

**Learnings/notes:**
- The Fact interface in `app/src/data/index.ts` already includes all fields needed (subject, format, formatDivisor, noCompute) but the server page was only passing a subset to the client component. Future additions should check this mapping.
