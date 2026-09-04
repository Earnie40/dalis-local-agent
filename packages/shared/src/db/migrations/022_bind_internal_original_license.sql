-- An "internal original" assertion is meaningful only when it is bound to
-- this repository/operator. Arbitrary third-party prefixes are provenance
-- claims, not verified permission grants, and must remain non-retrievable.

UPDATE knowledge_documents
   SET license_validated = false,
       retrieval_eligible = false
 WHERE license ~* '^[A-Za-z0-9._-]+-internal-original$'
   AND license !~* '^DACAIS-internal-original$';
