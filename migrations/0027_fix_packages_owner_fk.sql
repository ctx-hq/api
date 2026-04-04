-- Remove mutable column (feature removed in prior refactor).
-- D1 remote cannot disable FK checks (PRAGMA foreign_keys = OFF is ignored),
-- so we use ALTER TABLE DROP COLUMN instead of the table-rebuild pattern.
-- The owner_id FK removal is handled separately in 0028.
ALTER TABLE packages DROP COLUMN mutable;
