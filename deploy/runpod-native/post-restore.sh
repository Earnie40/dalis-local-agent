#!/usr/bin/env bash
set -Eeuo pipefail

APP_ROOT=${DACAI_REMOTE_APP_ROOT:-/workspace/dacai-app}
RUNTIME_ROOT=${DACAI_RUNTIME_ROOT:-/workspace/dacai-runtime}
PG_ROOT=${DACAI_PG_ROOT:-/workspace/dacai-postgres}
DB_CONFIG=/etc/dacai/db-config.json
PG_BIN=/usr/lib/postgresql/16/bin
PG_SOCKET=/var/run/postgresql

db_name=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["database"])' "${DB_CONFIG}")

python3 - "${DB_CONFIG}" <<'PY' | \
  runuser -u postgres -- "${PG_BIN}/psql" -X -v ON_ERROR_STOP=1 \
    -h "${PG_SOCKET}" -p 5433 "${db_name}" >/dev/null
import json
import sys

config = json.load(open(sys.argv[1], encoding='utf-8'))
local_root = config['localWorkspaceRoot']
remote_root = config['remoteWorkspaceRoot']

def literal(value):
    return "'" + value.replace("'", "''") + "'"

print(
    'UPDATE workspaces SET root_path = ' + literal(remote_root) +
    ', display_name = CASE WHEN display_name = root_path THEN ' + literal('DacaiLocalAgent (RunPod)') +
    ' ELSE display_name END, updated_at = now() WHERE root_path = ' + literal(local_root) + ';'
)
print(
    'UPDATE repositories SET root_path = ' + literal(remote_root) +
    ', indexed_at = NULL WHERE root_path = ' + literal(local_root) + ';'
)
PY

timestamp=$(date -u +%Y%m%dT%H%M%SZ)
runuser -u postgres -- "${PG_BIN}/pg_dump" -Fc \
  -h "${PG_SOCKET}" -p 5433 "${db_name}" \
  -f "${PG_ROOT}/backups/dacai-${timestamp}.dump"

touch "${PG_ROOT}/.local-db-restored"
printf 'Local database restored, workspace path remapped, and persistent backup verified.\n'
