-- Dedup existing open incidents: keep the earliest per (service, title),
-- then add a partial unique index to prevent future duplicates.

DELETE FROM service_health_incidents
WHERE id IN (
  SELECT id FROM (
    SELECT id, ROW_NUMBER() OVER (
      PARTITION BY service, title
      ORDER BY detected_at, id  -- keep earliest; id as tiebreaker
    ) AS rn
    FROM service_health_incidents
    WHERE status = 'open'
  ) ranked WHERE rn > 1
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_shi_open_service_title
  ON service_health_incidents (service, title) WHERE status = 'open';
