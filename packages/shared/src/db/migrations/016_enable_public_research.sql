-- Enable public-web browsing for workspaces created before the default changed.
-- The tools remain read-only and retain their public-source and SSRF safeguards.
ALTER TABLE workspaces
  ALTER COLUMN network_access SET DEFAULT TRUE;

UPDATE workspaces
SET network_access = TRUE
WHERE network_access = FALSE;
