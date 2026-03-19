#!/usr/bin/env bash
# ============================================================================
# Crux CLI Tab Completion (bash/zsh compatible)
# ============================================================================
#
# Installation:
#
#   # Add to ~/.bashrc or ~/.zshrc:
#   source /path/to/crux/completions/crux.bash
#
#   # If you use a shell alias:
#   alias crux='pnpm crux'
#   source /path/to/crux/completions/crux.bash
#
#   # For zsh, also ensure compinit and bashcompinit are loaded:
#   autoload -Uz compinit && compinit
#   autoload -Uz bashcompinit && bashcompinit
#   source /path/to/crux/completions/crux.bash
#
# ============================================================================

_crux_complete() {
  local cur prev words cword

  # Support both bash and zsh completion initialization
  if declare -F _init_completion &>/dev/null; then
    _init_completion || return
  else
    COMPREPLY=()
    cur="${COMP_WORDS[COMP_CWORD]}"
    prev="${COMP_WORDS[COMP_CWORD-1]}"
    words=("${COMP_WORDS[@]}")
    cword=$COMP_CWORD
  fi

  # ---------------------------------------------------------------------------
  # Groups (Level 1 shortcuts that expand to a set of domains)
  # ---------------------------------------------------------------------------
  local groups="w wiki fb factbase tb tablebase gh sys system"
  local toplevel="query context"
  local all_domains="validate analyze fix content generate visual resources updates auto-update check-links edit-log importance ci maintain review citations grokipedia issues agent-checklist entity pr wiki-server query jobs context enrich sessions research evals health epic ids agents agent-session-events audits release pr-patrol factbase footnotes agent-workspace import-grants backfill-grantee-ids backfill-program-ids import-divisions import-funding-programs people orgs research-areas backfill-stable-ids backfill-yaml-stable-ids factbase-migrate-entities verify qa-sweep matrix tablebase pages"

  # ---------------------------------------------------------------------------
  # Level 2: domains within each group
  # ---------------------------------------------------------------------------

  # wiki group (w/wiki): content-focused domains + flattened content commands
  local wiki_domains="validate fix content citations footnotes generate visual enrich importance updates auto-update analyze pages resources check-links qa-sweep evals research grokipedia"
  local wiki_flattened="improve iterate create regrade grade grade-content polish review suggest-links strip-scores"

  # factbase group (fb/factbase): factbase domains + flattened factbase commands
  local fb_domains="factbase factbase-migrate-entities"
  local fb_flattened="show list lookup validate properties search coverage fact stale needs-update migrate sync-sources verify add-fact"

  # tablebase group (tb/tablebase): tablebase-related domains + flattened commands
  local tb_domains="tablebase matrix entity ids people orgs research-areas import-grants import-divisions import-funding-programs verify"
  local tb_flattened="scan gaps next-task improve mark-done loop resolve submit existing create-entity ensure-entities fetch-page prepare sync-careers"

  # github group (gh): GitHub-related domains + flattened issues commands
  local gh_domains="issues pr ci epic release review pr-patrol"
  local gh_flattened="list next search create comment start done"

  # system group (sys/system): infrastructure & operations domains
  local sys_domains="agents agent-checklist agent-workspace agent-session-events jobs sessions edit-log health audits maintain wiki-server"

  # ---------------------------------------------------------------------------
  # Level 3: commands within each domain
  # ---------------------------------------------------------------------------
  local cmds_validate="all unified compile links entity-links cross-links mermaid style consistency data refs sidebar orphans quality schema edit-logs session-logs financials numeric-consistency drizzle-journal gate id-server-sync hallucination-risk entity-refs directory-pages cross-entity cross-check to-rdjsonl"
  local cmds_fix="all entity-links cross-links broken-links markdown escaping dollars comparisons frontmatter imports orphaned-footnotes related-pages frontmatter-order"
  local cmds_content="improve iterate create regrade grade grade-content polish review suggest-links strip-scores"
  local cmds_issues="list next search create comment update-body update-title lint start done cleanup close"
  local cmds_pr="create ready detect check overlaps fix-body rebase-all validate-test-plan resolve-conflicts"
  local cmds_agent_checklist="init check verify status complete snapshot pre-push-check"
  local cmds_factbase="show list lookup validate properties search coverage fact stale needs-update migrate sync-sources verify add-fact"
  local cmds_tablebase="scan gaps next-task improve mark-done loop resolve submit existing create-entity ensure-entities fetch-page verify prepare sync-careers"
  local cmds_query="search entity facts related backlinks page recent-changes recent-edits citations risk stats blocks"
  local cmds_context="for-issue for-page for-entity for-topic"
  local cmds_ci="status pause-actions resume-actions main-status"
  local cmds_ids="allocate check list"
  local cmds_agents="register status update heartbeat complete sweep"
  local cmds_health="check"
  local cmds_sessions="write"
  local cmds_audits="list check run-auto report"
  local cmds_maintain="report review-prs triage-issues detect-cruft fix-chains health-snapshot status mark-run"
  local cmds_jobs="list create status cancel retry sweep ping stats batch worker types"
  local cmds_wiki_server="sync sync-facts sync-entities sync-session sync-sessions sync-benchmarks sync-auto-update-runs sync-assessments snapshot-resources"
  local cmds_agent_workspace="setup sync-env list clean open refresh"
  local cmds_agent_session_events="log list"
  local cmds_epic="list create view comment update link unlink status close categories"
  local cmds_release="create"
  local cmds_citations="verify status report extract-quotes quote-report verify-quotes check-accuracy normalize-footnotes export-dashboard backfill-resource-ids fix-inaccuracies audit audit-check content-coverage register-resources"
  local cmds_auto_update="run run-ci digest plan sources history submit audit-gate verify-citations risk-scores content-checks pr-body"
  local cmds_people="discover create link-resources enrich import-key-persons suggest-links"
  local cmds_orgs="enrich"
  local cmds_research_areas="link-grants backfill-papers discover-orgs stats"
  local cmds_matrix="scores pages next-task mark-done"
  local cmds_entity="rename"
  local cmds_pages="next-action"
  local cmds_generate="yaml summaries diagrams schema-diagrams schema-docs"
  local cmds_visual="create review audit improve embed"
  local cmds_resources="list show process create metadata rebuild-citations validate refresh-titles"
  local cmds_updates="list run triage stats"
  local cmds_check_links="check"
  local cmds_edit_log="view list stats"
  local cmds_importance="show sync rank seed rerank"
  local cmds_review="mark status list stats"
  local cmds_enrich="entity-links fact-refs"
  local cmds_evals="run hunt inject scan"
  local cmds_footnotes="migrate-cr"
  local cmds_grokipedia="match"
  local cmds_qa_sweep="run recent checks"
  local cmds_pr_patrol="run once parallel status history stats explain merge-status branch-agent"
  local cmds_analyze="all links entity-links quality scan"
  local cmds_records_verify="stats"
  local cmds_import_grants="analyze sync download dedup"
  local cmds_import_divisions="list sync"
  local cmds_import_funding_programs="list sync"

  # ---------------------------------------------------------------------------
  # Completion logic
  # ---------------------------------------------------------------------------

  # Determine effective position: skip "pnpm" if the command starts with it
  local effective_cword=$cword
  local effective_words=("${words[@]}")
  if [[ "${words[0]}" == "pnpm" ]]; then
    # "pnpm crux ..." — effective position shifts by 2 (pnpm + crux)
    effective_cword=$((cword - 2))
    effective_words=("${words[@]:2}")
  else
    # "crux ..." — effective position shifts by 1
    effective_cword=$((cword - 1))
    effective_words=("${words[@]:1}")
  fi

  # Level 1: completing the group/domain
  if [[ $effective_cword -le 0 ]]; then
    COMPREPLY=( $(compgen -W "$groups $toplevel $all_domains" -- "$cur") )
    return
  fi

  local arg1="${effective_words[0]}"

  # Level 2: completing after a group prefix
  if [[ $effective_cword -eq 1 ]]; then
    case "$arg1" in
      w|wiki)
        COMPREPLY=( $(compgen -W "$wiki_domains $wiki_flattened" -- "$cur") )
        return ;;
      fb|factbase)
        COMPREPLY=( $(compgen -W "$fb_domains $fb_flattened" -- "$cur") )
        return ;;
      tb)
        COMPREPLY=( $(compgen -W "$tb_domains $tb_flattened" -- "$cur") )
        return ;;
      gh)
        COMPREPLY=( $(compgen -W "$gh_domains $gh_flattened" -- "$cur") )
        return ;;
      sys|system)
        COMPREPLY=( $(compgen -W "$sys_domains" -- "$cur") )
        return ;;
    esac
  fi

  # Determine the domain: for groups, arg2 is the domain; otherwise arg1
  local domain="$arg1"
  local completing_command=false
  case "$arg1" in
    w|wiki|fb|tb|gh|sys|system)
      if [[ $effective_cword -eq 1 ]]; then
        # Already handled above
        return
      fi
      domain="${effective_words[1]}"
      if [[ $effective_cword -eq 2 ]]; then
        completing_command=true
      fi
      ;;
    *)
      if [[ $effective_cword -eq 1 ]]; then
        completing_command=true
      fi
      ;;
  esac

  # Level 3 (or level 2 for flat domains): completing the command within a domain
  if [[ "$completing_command" == true ]]; then
    # Convert domain name to variable-safe form (hyphens to underscores)
    local varname="cmds_${domain//-/_}"
    local cmd_list="${!varname}"

    if [[ -n "$cmd_list" ]]; then
      COMPREPLY=( $(compgen -W "$cmd_list" -- "$cur") )
    fi
    return
  fi

  # Level 4+: common global flags
  if [[ "$cur" == -* ]]; then
    COMPREPLY=( $(compgen -W "--help --ci --fix --json --verbose --limit --all --dry-run" -- "$cur") )
    return
  fi
}

# Register completion for both 'crux' (alias) and 'pnpm' (with crux subcommand)
complete -F _crux_complete crux

# Also register for 'pnpm' when the second word is 'crux'
# This requires a wrapper that checks context
_pnpm_crux_complete() {
  # Only activate when "crux" is one of the words
  local i
  for i in "${COMP_WORDS[@]}"; do
    if [[ "$i" == "crux" ]]; then
      _crux_complete
      return
    fi
  done
}

# Uncomment the line below if you want completion for `pnpm crux ...` directly.
# Note: this replaces any existing pnpm completions.
# complete -F _pnpm_crux_complete pnpm
