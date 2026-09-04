-- A retrievable document must identify its stable source as well as its rights
-- basis and exact content digest. Legacy rows without that provenance remain
-- stored for audit, but are quarantined from retrieval.

UPDATE knowledge_documents
   SET retrieval_eligible = false
 WHERE retrieval_eligible
   AND (source_id IS NULL OR btrim(source_id) = '');

ALTER TABLE knowledge_documents
  DROP CONSTRAINT IF EXISTS knowledge_documents_retrieval_provenance_check;

ALTER TABLE knowledge_documents
  ADD CONSTRAINT knowledge_documents_retrieval_provenance_check
  CHECK (
    NOT retrieval_eligible
    OR (
      license_validated
      AND license IS NOT NULL
      AND btrim(license) <> ''
      AND source_id IS NOT NULL
      AND btrim(source_id) <> ''
      AND content_hash ~ '^[0-9A-Fa-f]{64}$'
    )
  );
