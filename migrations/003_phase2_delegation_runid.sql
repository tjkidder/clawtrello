ALTER TABLE card_delegations
  ADD COLUMN IF NOT EXISTS run_id TEXT;

ALTER TABLE card_delegations
  ADD COLUMN IF NOT EXISTS session_key_format TEXT;

CREATE INDEX IF NOT EXISTS idx_delegations_run_id
  ON card_delegations(run_id)
  WHERE run_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_delegations_session_key
  ON card_delegations(session_key)
  WHERE session_key IS NOT NULL;
