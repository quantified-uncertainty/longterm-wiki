-- Fix broken Coefficient Giving grant source URLs.
-- The old /grants/ page returns 404 after the Open Philanthropy → Coefficient Giving rebrand.
-- The grants are now listed per-fund at /funds/.
-- Also updates the criminal justice program source URL which used a /grants/?q= query pattern.

UPDATE grants
SET source = 'https://coefficientgiving.org/funds/',
    updated_at = now()
WHERE source = 'https://coefficientgiving.org/grants/';

UPDATE funding_programs
SET source = 'https://coefficientgiving.org/grant-publishing-process/',
    updated_at = now()
WHERE source = 'https://coefficientgiving.org/grants/?q=&focus-area=criminal-justice-reform';
