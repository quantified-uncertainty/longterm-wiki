CREATE TABLE wikibase_page_assessments (
  id            BIGSERIAL PRIMARY KEY,
  page_id_int   INTEGER,  -- references wiki_pages(integer_id); no FK because integer_id is added by manual migration (Phase 4a)
  assessor      TEXT NOT NULL,
  method        TEXT,
  model         TEXT,
  quality       INTEGER,
  reader_importance   REAL,
  research_importance REAL,
  tactical_value      REAL,
  rating_focus        REAL,
  rating_novelty      REAL,
  rating_rigor        REAL,
  rating_completeness REAL,
  rating_concreteness REAL,
  rating_actionability REAL,
  rating_objectivity  REAL,
  structural_score    INTEGER,
  word_count          INTEGER,
  note          TEXT,
  assessed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_wpa_page_assessor_time ON wikibase_page_assessments (page_id_int, assessor, assessed_at DESC);
CREATE INDEX idx_wpa_page_time ON wikibase_page_assessments (page_id_int, assessed_at DESC);
CREATE INDEX idx_wpa_assessor ON wikibase_page_assessments (assessor);
