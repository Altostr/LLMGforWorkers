ALTER TABLE logs ADD COLUMN log_event_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_logs_log_event_id
  ON logs(log_event_id)
  WHERE log_event_id IS NOT NULL;
