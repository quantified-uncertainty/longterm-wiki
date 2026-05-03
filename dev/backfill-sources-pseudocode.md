# `crux tb backfill-sources` — Pseudocode

## Top level

```
main():
  records = fetch_missing_sources(limit, table)
  for record in records:
    if skip(record): continue
    if over_budget(): break
    process(record)
  report(outcomes)
```

## Level 1

```
process(record):
  query   = build_search_query(record)
  sources = run_research(query)
  matches = verify(sources, record)
  if matches empty: return no_match
  chosen  = matches[0]  if len(matches)==1  else  rank(matches)
  if apply: write_source(record, chosen.url)
  return chosen
```

## Level 2

```
run_research(query):
  hits = parallel(exa, perplexity, scry, github?, semantic_scholar?, federal_register?)
  hits += pg_resource_lookup(query)
  urls = dedupe_normalize(hits).take(5)
  return [scrape(url) for url in urls]


verify(sources, record):
  matches = []
  for s in sources:
    if self_domain(s.url): continue
    if len(s.content) < 50: continue
    if not mentions_entity(s, record): continue
    quotes = haiku_extract_quotes(s.content, claim, entity)
    quotes = [q for q in quotes if substring_in(q, s.content)]
    if not quotes: continue
    if not sonnet_entails(quotes, claim): continue
    matches.append(s with quotes)
  return matches


rank(matches):
  return matches[ haiku_pick_best(matches, claim, entity) ]
```

## Level 3

```
fetch_missing_sources(limit, table):
  GET /api/sourcing/missing-sources?limit&table
  → for t in [facts, personnel, investments, equity_positions,
              policy_stakeholders, divisions, funding_rounds,
              funding_programs, publications, page_citations]:
      SELECT * FROM t WHERE source IS NULL OR source = ''
  return flatten(rows)


skip(record):
  return  extract_match_terms(record) empty
       or record is test/seed
       or extract_match_terms(record) returns []


build_search_query(record):
  return (record.entity_name + ' ' + record.description)[:200]


mentions_entity(source, record):
  targets = entities_to_mention(record)   # personnel: [person, org]; else: [entity]
  for slot in targets:
    variants = name_variants(slot)        # original, slug→words, accent-stripped, alias
    if not any(v in source.content or v in source.url for v in variants):
      return false
  return true


haiku_extract_quotes(content, claim, entity):
  prompt = "Find up to 3 verbatim passages supporting the claim, else []"
  return haiku(prompt).quotes


substring_in(quote, content):
  norm = lowercase + keep [a-z0-9] + collapse whitespace
  return norm(quote) in norm(content)


sonnet_entails(quotes, claim):
  prompt = "Do these quotes (+ source URL/title) entail the claim?"
  return sonnet(prompt).supports == true


haiku_pick_best(matches, claim, entity):
  prompt = "Pick index of source that best directly supports the claim"
  return haiku(prompt).pickedIndex


write_source(record, url):
  POST /api/sourcing/update-source { table, recordId, url }


report(outcomes):
  print summary(counts, costs, providers)
  if verbose: print per-record list
  write JSON to dev/reports/backfill-unmatched-<timestamp>.json
```
