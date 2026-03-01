# Error Handling Strategy

This document defines when and how to handle errors in the longterm-wiki codebase. Follow these rules when writing new code or modifying existing error handling.

## Core Principle

**Every catch block must either log, re-throw, or have a comment explaining why it does neither.** Silent error swallowing (`.catch(() => {})`) is prohibited.

## Decision Matrix

| Context | Strategy | Example |
|---------|----------|---------|
| **Critical path** (build, validation, CI gate) | Fail-closed: re-throw or exit with error | Gate validation, build-data |
| **Best-effort telemetry** (wiki-server recording) | Log warning + continue | `recordRunToServer().catch(e => logger.warn(...))` |
| **Expected failures** (health-check pinging a down server) | Log at debug/info level + continue | `recordIncident().catch(e => { void e; })` with comment |
| **High-frequency operations** (heartbeats, polling) | Log at debug level | `sendHeartbeat().catch(e => logger.debug(...))` |
| **Non-critical display data** (fetching optional metadata) | Log warning + return fallback value | `fetchIssue().catch(e => { console.warn(...); return null; })` |
| **LLM triage / optimization** | Fail-closed: return "run everything" | Gate triage returns empty skip set on error |

## `.catch()` Usage

### Prohibited

```typescript
// BAD: silent swallowing — no one knows this failed
someAsyncCall().catch(() => {});
```

### Acceptable Patterns

```typescript
// GOOD: log with context
someAsyncCall().catch((e) =>
  logger.warn({ error: e instanceof Error ? e.message : String(e) }, "Context about what failed")
);

// GOOD: fire-and-forget with tracking (for wiki-server calls)
recordRunToServer(config, payload)
  .then(onSuccess, (e) => onError(e, "context"));

// GOOD: expected failure with documented reason
recordIncident(config, payload).catch((e: unknown) => {
  // Intentionally quiet: wiki-server is likely the thing that's down.
  // GitHub issue creation below is the reliable fallback.
  void e;
});

// GOOD: return fallback value with warning
const data = await fetchOptionalData().catch((e) => {
  console.warn(`Failed to fetch optional data: ${e instanceof Error ? e.message : String(e)}`);
  return null;
});
```

## `.catch(logger.warn)` vs `.catch(logger.error)` vs Bubbling

- **`logger.warn`**: The operation was best-effort and failure is recoverable. Used for wiki-server recording, agent status updates, non-critical API calls.
- **`logger.error`**: The operation was expected to succeed and failure indicates a real problem, but we can still continue. Used for GitHub API failures, unexpected data format issues.
- **Bubble (re-throw)**: The operation is on the critical path and failure should stop execution. Used for build steps, validation, data loading.
- **`logger.debug`**: The operation fails frequently and logging at higher levels would flood output. Used for heartbeats, polling.

## When Fire-and-Forget Is Acceptable

Fire-and-forget (async call without awaiting) is acceptable **only** when ALL of these conditions are met:

1. The call is for **telemetry, metrics, or status updates** (not user-facing functionality)
2. Failure does **not affect correctness** of the main operation
3. The error is **logged** (at warn level or higher, unless high-frequency)
4. There is a **fallback notification channel** (e.g., Discord, GitHub issues) for critical failures

Examples of acceptable fire-and-forget:
- `recordRunToServer()` — groundskeeper run recording to wiki-server
- `updateActiveAgent()` — agent status heartbeat
- `sendDiscordNotification()` — notification (but should log if it fails)

Examples where fire-and-forget is NOT acceptable:
- Database writes that affect user-visible data
- GitHub issue creation (the primary notification channel)
- File writes (data integrity)

## Fail-Open vs Fail-Closed Defaults

### Fail-Closed (default for validation/CI)

The gate check and CI pipeline should fail-closed: if something goes wrong, run all checks rather than skipping any. This prevents false "all clear" results.

Every fail-open exception in the gate must have a comment explaining why. Current documented exceptions:

- **assign-ids**: Wiki-server may be unavailable; build-data has a local fallback
- **typecheck-crux**: Known baseline of pre-existing errors; separate baseline check enforces limits
- **mdx-compile**: Advisory smoke-test; full Next.js build is authoritative
- **gate-triage LLM call**: Optimization only; timeout/error means run everything

### Fail-Open (only for non-critical paths)

Fail-open is appropriate when:
- The operation is an optimization (triage, caching)
- There is an independent, more authoritative check that catches the same class of errors
- Blocking would prevent legitimate workflows (e.g., offline development)

## Wiki-Server Failure Tracking (Groundskeeper)

The groundskeeper uses a consecutive failure counter for wiki-server calls:

- Each failed call increments the counter and logs a warning
- At 5 consecutive failures, a summary warning is logged ("wiki-server appears unreachable")
- Above the threshold, individual failures are suppressed to avoid log flooding
- When a call succeeds, the counter resets and a recovery message is logged

This provides visibility into extended outages without overwhelming logs during them.
