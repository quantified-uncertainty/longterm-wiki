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

Run the **suggested search queries** from the prepare output using WebSearch. Look for names, roles, dates, amounts — whatever the task type requires.

### Step 3: Resolve or create entities

For each person/org/benchmark found in research:

```bash
pnpm crux tablebase resolve "Person Name" --ci
```

If `"found":false`, create the entity:

```bash
pnpm crux tablebase create-entity "Person Name" --type=person --ci
```

Use the returned `stableId` in your records.

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
