# Database and Persistence

This document describes how agents should discover and interact with persistence.

Do not put live passwords or full connection strings in this file.

## PostgreSQL discovery

When PostgreSQL is needed, search the repository/environment for:

- `DATABASE_URL`
- `POSTGRES_URL`
- `PGHOST`
- `PGPORT`
- `PGDATABASE`
- `PGUSER`
- ORM/client configuration
- Prisma configuration
- Docker/Compose configuration
- Railway/cloud deployment configuration

Do not assume the host or port.

## Connection verification

Before database-dependent work, verify:
- database process/service availability
- host/port
- database name
- schema compatibility
- required extensions
- connection permissions

## Secrets

Never print:
- database passwords
- full credential-bearing URLs
- private connection secrets

A sanitized connection summary is acceptable:

```text
engine=postgresql
host=localhost
port=5433
database=dacai_local_agent
credentials=[REDACTED]
```

## pgvector / embeddings

If vector search is present:

- inspect the real schema before changing it
- verify embedding dimensions
- verify distance/operator class
- verify indexes
- do not mix incompatible embedding models in one vector column without an explicit migration design

## Schema changes

For schema changes:
- inspect existing migrations
- use the project's migration mechanism
- prefer additive changes
- preserve existing data
- validate indexes/constraints
- add tests where appropriate

Never silently drop production data.

## Operational versus knowledge data

Keep a conceptual distinction between:

- operational application state
- task state
- agent memory
- knowledge/RAG chunks
- embeddings
- audit/evidence records

Do not merge them into one unstructured store merely for convenience.
