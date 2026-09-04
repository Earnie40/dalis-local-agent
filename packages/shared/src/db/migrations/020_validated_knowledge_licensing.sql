-- Retrieval is fail-closed on an application-validated rights basis. Existing
-- public-web labels described provenance but did not grant ingestion rights,
-- so they are quarantined rather than silently treated as licences.

ALTER TABLE knowledge_documents
  ADD COLUMN IF NOT EXISTS license_validated BOOLEAN NOT NULL DEFAULT false;

-- Backfill only the locally authored corpus and common explicit identifiers
-- already accepted by the policy. Future writes set this flag only after the
-- application licence gate succeeds.
UPDATE knowledge_documents
   SET license_validated = true
 WHERE content_hash ~ '^[0-9A-Fa-f]{64}$'
   AND (
     license ~* '^[A-Za-z0-9._-]+-internal-original$'
     OR license ~* '^(MIT|ISC|Unlicense|0BSD|Apache-2[.]0|BSD-(2|3)-Clause|MPL-2[.]0|EPL-2[.]0|Python-2[.]0|BlueOak-1[.]0[.]0|CC0-1[.]0|CC-BY(-[A-Z-]+)?-[34][.]0|ODC-(BY|ODbL|PDDL)-1[.]0)$'
     OR license ~* '^public[- ]domain$'
   );

UPDATE knowledge_documents
   SET retrieval_eligible = false
 WHERE retrieval_eligible
   AND (
     NOT license_validated
     OR license IS NULL
     OR btrim(license) = ''
     OR content_hash !~ '^[0-9A-Fa-f]{64}$'
   );

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
      AND content_hash ~ '^[0-9A-Fa-f]{64}$'
    )
  );

CREATE INDEX IF NOT EXISTS idx_knowledge_documents_validated_retrieval
  ON knowledge_documents (retrieval_eligible, license_validated)
  WHERE retrieval_eligible AND license_validated;
