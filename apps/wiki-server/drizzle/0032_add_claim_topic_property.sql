-- Add topic and property columns to claims table
-- Topic: high-level topical cluster (founding, funding, leadership, etc.)
-- Property: structured property name (foundedDate, founder, ceo, etc.)

ALTER TABLE claims ADD COLUMN topic text;
ALTER TABLE claims ADD COLUMN property text;

CREATE INDEX idx_cl_topic ON claims (topic);
CREATE INDEX idx_cl_property ON claims (property);
