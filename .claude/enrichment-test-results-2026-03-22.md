# Enrichment Test Results — 2026-03-22

## Run Parameters
- Command: `WIKI_SERVER_ENV=prod pnpm crux tb loop --max=10 --budget=20 --model=auto`
- Cost: **$21.75** (3 tasks attempted, 0 records saved due to server bug)
- Duration: 987s (~16 min)

## What Worked (keep this data!)
The research + entity creation worked perfectly. These entities were created in prod PG:

### Task 1: Ada Lovelace Institute (ovKIy6K2dXWt) — $7.03
Created ~30 person entities including:
- Gaia Marcus (ANdg2ncDV8), Carly Kind (spEbbvDORS), Francine Bennett (jglOZwebMM)
- Sir Alan Wilson (yahRposJ7z), Octavia Field Reid (1LHbtlSYdv), Imogen Parker (z2BtaF_9Jb)
- Michael Birtwistle (t7jyFck61X), Alix Dunn (3KPnjZAOdI), Helen Margetts (pgE1JY_4xA)
- Huw Price (T6SowQJJbg - already existed), Hetan Shah (7jKImlNypJ), Azeem Azhar (dmdLxbKsAB)
- John Thornhill (S9tutXmnJX), Rocio Concha Galguera (lJOAlKm9vb), Shannon Vallor (Nn5nrkNoQN)
- Shakir Mohamed (WzaqeNeTCB), Ali Shah (1nlRBHVJsv), Chris Todd (A4vmTGy5Sv)
- Roshni Modhvadia (E-cmuJWmfg), Matt Davies (viRwZ577IX), Nuala Polo (j_ncM9x2iy)
- Eleanor O'Keeffe (eIzHL1VcZJ), Mavis Machirori (Wh0tR_H26A), Lara Groves (6rS1bLQsc2)
- Harry Farmer (uEi1kZDirX), Julia Smakman (xzvgguovKh), Oliver Bruff (9DINYinKTX)
- Sohaib Malik (9dcWL-FqbB), Anna Studman (Z76Yb8GerL), Elliot Jones (WGolTMRBAN)
- Friederike Schüür (xFSQfZoUVk), Anna Colom (Lm6P5_A96T)

### Task 2: ARIA (ecVmpHPyb5l1) — $6.88
Created ~45 person entities including:
- Ilan Gur (PJvyf_RYV7), Matt Clifford (EWTG4ReRam), Kathleen Fisher (Q0hj4MAOqJ)
- Antonia Jenkinson (kcch6QfwgT), Pippy James (XQ5NvbsNy7), Ant Rowstron (8OhBgdOa_R)
- Dan Sherwood (BJdYg9s5-G), Kate Bingham (ZTM0-qmuin), Patrick Vallance (lShdTHCKRf)
- Angela McLean (-1bf12vX1G), Sarah Hunter (g9jjV7qxz3), Stephen Cohen (rMxkE-Qk7f)
- David MacMillan (STNor5dA7A), Strive Masiyiwa (8Et4KtQNbh), Nick McKeown (fVNZWOetDu)
- Max Jaderberg (P6oMGQEzaZ), Demis Hassabis (Aqcyu3onCA - already existed)
- Hayaatun Sillem (eTwNuA_UR7), Özlem Türeci (De0U-V16pO), Gemma Bale (pVlASk7Ivo)
- Suraj Bramhavar (XAb1xuUcZj), Angie Burnett (-KxkGArNM2), Jacques Carolan (e0-zNWkoBy)
- Jenny Read (PXu2Lhs25W), Mark Symes (pFd_WbkzIs), David Dalrymple (SQlb1r5EzN)
- Sarah Bohndiek (754qEuTmOI), Ivan Jayapurna (U-XOmjgmei), Claire Donoghue (S0oDLKskmI)
- Yannick Wurm (7wzNuTPvxo), Alexandre Obadia (2tXR4UaShb), Nathan Wolfe (EMrlFaahii)
- Brian Wang (NwcOhYH8sS), Nicole Wheeler (HGZPTCkOlX), Rico Chandra (JghtclwbA6)
- Ryan (vCWFlOuC4o), Muji Ahmedi (TU5y2W9xMW), Luke Simpson (m_nZu5SCSH)

### Task 3: AI Now Institute (Jrb2_QSNbCu-) — $7.84
Created ~15 person entities including:
- Amba Kak (mZrTkx_RXk), Sarah Myers West (PHcf_t-yuY), Meredith Whittaker (DnWz-y8BuY)
- Kate Crawford (77SnPuPnk8), Heidy Khlaaf (npfho6p1QL), Frederike Kaltheuner (wsVp-q6vg9)
- Brian Merchant (O9-antI1B4), Varoon Mathur (xIgCidq_0i), Leevi Saari (qp2R5diHia)
- Mehtab Khan (B4ZChPOGpY), Alix Dunn (3KPnjZAOdI - reused from task 1)
- Lucy Suchman (mLr8phls1l), Molly de Blanc (GpH-7gvgfH), Jai Vipra (tyAjybH93j)
- Anna Lenhart (L7hnSNOexk)

## What Failed — Server Bug

**Every `submit_records` call returned 500.** The INSERT succeeded but the post-sync UPDATE failed.

### Root Cause
File: `apps/wiki-server/src/routes/tablebase/personnel.ts` lines 370-402

The post-sync FK resolution queries use:
```sql
AND p.id = ANY(${syncedIds})
```

Where `syncedIds` is a JS string array passed via Drizzle's `sql` template tag. Drizzle serializes this as individual parameters (`$1`), not a PostgreSQL array. PostgreSQL's `ANY()` expects an array, so it gets `ANY('TEST_12345')` instead of `ANY(ARRAY['TEST_12345'])`.

### Reproduction
```bash
WIKI_SERVER_ENV=prod pnpm crux tb submit --table=personnel <<'JSON'
[{"id":"TEST_12345","personId":"Aqcyu3onCA","organizationId":"A4XoubikkQ","role":"Test","roleType":"career","source":"https://test.com","notes":"test"}]
JSON
```

Returns: `500: {"error":"internal_error","message":"Failed query: UPDATE personnel p SET person_entity_id = e.stable_id ... AND p.id = ANY(($1)) params: TEST_12345"}`

### Fix
Replace `ANY(${syncedIds})` with `= ANY(${sql.param(syncedIds)})` or use `IN` with proper array serialization. There are 4 occurrences on lines 377, 385, 393, 401.

## Recovery Plan
1. Fix the server bug (4 lines)
2. Deploy
3. Re-run with --budget=2 to verify fix
4. The ~90 person entities created in this run are still valid — only the personnel RECORDS need to be created
