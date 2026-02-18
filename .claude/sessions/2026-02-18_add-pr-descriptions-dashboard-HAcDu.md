## 2026-02-18 | claude/add-pr-descriptions-dashboard-HAcDu | Add PR Descriptions dashboard

**What was done:** Added a new internal dashboard at `/internal/pr-descriptions` that displays all GitHub pull requests with their titles, descriptions, state, author, dates, and diff stats. Expandable rows show full PR descriptions. Extended the build pipeline to fetch and store full PR metadata from the GitHub API.

**Issues encountered:**
- GITHUB_TOKEN not available in dev environment, so PR data is empty locally — handled gracefully with empty state messaging

**Learnings/notes:**
- The GitHub PR list API already returns title, body, state, dates, labels, etc. — no additional API calls needed beyond the existing pagination
- Shared the API call between `fetchBranchToPrMap` and `fetchPrItems` via caching to avoid duplicate requests
