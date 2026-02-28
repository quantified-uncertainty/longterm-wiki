-- Service health incident tracking for unified monitoring dashboard
CREATE TABLE IF NOT EXISTS service_health_incidents (
  id BIGSERIAL PRIMARY KEY,
  service TEXT NOT NULL,
  severity TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  title TEXT NOT NULL,
  detail TEXT,
  detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ,
  resolved_by TEXT,
  check_source TEXT,
  metadata JSONB,
  github_issue_number INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_shi_service ON service_health_incidents (service);
CREATE INDEX idx_shi_status ON service_health_incidents (status);
CREATE INDEX idx_shi_severity ON service_health_incidents (severity);
CREATE INDEX idx_shi_detected_at ON service_health_incidents (detected_at);
CREATE INDEX idx_shi_service_status ON service_health_incidents (service, status);
