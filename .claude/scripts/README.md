# Local Automation (launchd)

macOS launchd jobs that run Claude Code via subscription. These poll on a schedule and invoke Claude Code CLI — no API credits consumed.

## Jobs

| Job | Schedule | Working Dir | Trigger Condition |
|-----|----------|-------------|-------------------|
| **Auto-Update** | Daily at 9:00 AM | `lw/a10` | Always runs |
| **Maintenance Sweep** | Every 4 hours | `lw/a11` | Only if >= 6 PRs merged since last run |

### Auto-Update (`com.longtermwiki.auto-update`)

Runs `/auto-update` to fetch news and refresh wiki pages. Pulls latest main, then invokes `claude -p "/auto-update"`.

- **Script:** `auto-update-cron.sh`
- **Plist:** `com.longtermwiki.auto-update.plist`
- **Logs:** `~/.claude/auto-update-logs/`
- **Env vars:** `DRY_RUN=1` to preview without running

### Maintenance Sweep (`com.longtermwiki.maintenance`)

Runs `/maintain` to review PRs, triage issues, fix TS errors, and clean up cruft. Checks merged PR count first — exits immediately if below threshold.

- **Script:** `maintenance-cron.sh`
- **Plist:** `com.longtermwiki.maintenance.plist`
- **Logs:** `~/.claude/maintenance-logs/`
- **Env vars:** `FORCE=1` to skip PR count check, `DRY_RUN=1` to preview

## Setup (all jobs)

```bash
# 1. Create log directories
mkdir -p ~/.claude/auto-update-logs ~/.claude/maintenance-logs

# 2. Copy plists to LaunchAgents
cp .claude/scripts/com.longtermwiki.*.plist ~/Library/LaunchAgents/

# 3. Load all jobs
launchctl load ~/Library/LaunchAgents/com.longtermwiki.auto-update.plist
launchctl load ~/Library/LaunchAgents/com.longtermwiki.maintenance.plist

# 4. Verify
launchctl list | grep longtermwiki
```

## Managing jobs

```bash
# Check status
launchctl list | grep longtermwiki

# Unload (stop scheduling)
launchctl unload ~/Library/LaunchAgents/com.longtermwiki.maintenance.plist

# Reload after editing plist
launchctl unload ~/Library/LaunchAgents/com.longtermwiki.maintenance.plist
launchctl load ~/Library/LaunchAgents/com.longtermwiki.maintenance.plist

# Run manually (outside launchd)
.claude/scripts/maintenance-cron.sh
FORCE=1 .claude/scripts/maintenance-cron.sh   # skip PR count gate

# View logs
tail -f ~/.claude/maintenance-logs/launchd-stdout.log
ls -lt ~/.claude/maintenance-logs/*.log | head -5
```

## Notes

- Jobs survive terminal closure and reboots (launchd persists across login sessions)
- If the machine is asleep at scheduled time, launchd runs at next wake
- Each job uses a dedicated agent slot (`lw/aN`) to avoid conflicts
- Log files auto-clean after 30 days
- GUI management: [LaunchControl](https://www.soma-zone.com/LaunchControl/) ($34) for visual management of all jobs
