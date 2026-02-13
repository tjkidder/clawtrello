ALTER TABLE card_events
  ADD COLUMN IF NOT EXISTS event_key TEXT,
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'app',
  ADD COLUMN IF NOT EXISTS actor_agent_id TEXT;

ALTER TABLE card_delegations
  ADD COLUMN IF NOT EXISTS external_status TEXT,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_card_events_card_created ON card_events(card_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_card_events_event_key ON card_events(event_key);
CREATE INDEX IF NOT EXISTS idx_card_delegations_card_id ON card_delegations(card_id);
CREATE INDEX IF NOT EXISTS idx_card_delegations_status ON card_delegations(status);

CREATE UNIQUE INDEX IF NOT EXISTS idx_card_delegations_run_id ON card_delegations(run_id) WHERE run_id IS NOT NULL;
