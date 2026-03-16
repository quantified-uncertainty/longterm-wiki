# TableBase Enrich (Subscription Mode)

Enrich structured data (personnel, funding rounds, investments, benchmarks) using the subscription instead of API billing. Processes up to 5 tasks per invocation.

**Schedule:** `/loop 4h /tablebase-enrich` for periodic runs.

**Do NOT run `/agent-session-start`** — this skill manages its own workflow.

## The loop

Repeat this cycle up to 5 times:

### Step 1: Get next task

```bash
pnpm crux tablebase prepare
```

If output is `NO_TASKS`, stop. Otherwise, read the task details, search queries, and record template.

### Step 2: Research

Follow the **research strategy** from the prepare output:

1. **Try the team page first** (if URLs are provided). Use WebFetch with the prompt: "List ALL team members with their full names and roles/titles." Try each URL until one works — team pages often yield 10-50+ people in one call.

2. **If WebFetch returns empty/404**, the page may be JS-rendered. Use Playwright:
   ```bash
   pnpm crux tablebase fetch-page "https://example.com/team"
   ```
   This renders the page with a real browser and returns the text content.

3. **Fall back to WebSearch** if team pages don't work. Use the suggested search queries. Also try `"<org name>" site:linkedin.com/company` for additional context.

4. **If divisions are listed**, look specifically for team leads of each division — these are high-priority personnel targets.

5. **For notable researchers** at large orgs (Anthropic, DeepMind, etc.), search for specific people by name to find roles, start dates, and publications. Researchers with many papers or media mentions are higher priority.

### Step 3: Resolve or create entities

Collect all person names found in research into a JSON array and run:

```bash
echo '["Jaime Sevilla","Ben Cottier","David Owen"]' | pnpm crux tablebase ensure-entities --type=person --ci
```

This resolves existing entities and creates new ones in a single batch call. Output is a JSON array of `{name, stableId, created}` — use each `stableId` in your records.

For a single entity, you can also use:
```bash
pnpm crux tablebase resolve "Person Name" --ci
# If not found:
pnpm crux tablebase create-entity "Person Name" --type=person --ci
```

### Step 4: Submit records

Pipe a JSON array of records using the template from Step 1:

```bash
cat <<'RECORDS' | pnpm crux tablebase submit --table=<table>
[
  {"personId":"<stableId>","organizationId":"<entityId>","role":"CEO","roleType":"key-person","source":"https://..."}
]
RECORDS
```

Every record **must** have a `source` URL.

### Step 5: Mark done and continue

```bash
pnpm crux tablebase mark-done <taskId>
```

Go back to Step 1.

## Rules

- Only submit data confirmed by web search. No fabrication.
- Every record needs a source URL.
- Cross-reference key facts across 2+ sources when possible.
- If you can only find a year, use `YYYY` — don't guess month/day.
- `roleType` must be: `key-person`, `board`, or `career`.

## At the end

Print a one-line summary: `Enriched X entities, Y records created, Z entities created.`
