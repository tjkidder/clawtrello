ALTER TABLE card_delegations
  ADD COLUMN IF NOT EXISTS session_key_format TEXT;

CREATE INDEX IF NOT EXISTS idx_card_delegations_session_key
  ON card_delegations(session_key)
  WHERE session_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_card_delegations_format
  ON card_delegations(session_key_format)
  WHERE session_key_format IS NOT NULL;
