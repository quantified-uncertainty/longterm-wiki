Hi, Ozzie! I'm going to push a PR for that to production. In the meantime I have also inspected some of the sources backfill results from the last run.

ran a tiebreaker on the 106 cases where our two judges (sonnet + a local open-weight model) disagreed. opus sided with the local model 53% vs sonnet 47%. on facts: sonnet accepted 23 false matches vs the local model's 5; on page_citations: sonnet dropped 14 real matches vs the local model's 7. cost of the opus tiebreaker run for 106 disagreement cases: $1.22.
