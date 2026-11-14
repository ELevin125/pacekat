-- M4: undo for accepted readiness suggestions (snapshot of the sessions before the change).
ALTER TABLE plan_suggestions ADD COLUMN undo_json TEXT;
