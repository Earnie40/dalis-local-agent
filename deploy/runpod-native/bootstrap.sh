#!/usr/bin/env bash
set -Eeuo pipefail

if [[ $(id -u) -ne 0 ]]; then
  printf 'RunPod native bootstrap must run as root.\n' >&2
  exit 1
fi

APP_ROOT=${DACAI_REMOTE_APP_ROOT:-/workspace/dacai-app}
RUNTIME_ROOT=${DACAI_RUNTIME_ROOT:-/workspace/dacai-runtime}
PG_ROOT=${DACAI_PG_ROOT:-/workspace/dacai-postgres}
PG_DATA=${DACAI_PG_DATA:-/var/lib/postgresql/dacai}
PG_FSYNC_TEST=/var/lib/postgresql/dacai-fsync-test
PG_SOCKET=/var/run/postgresql
DB_CONFIG=/etc/dacai/db-config.json
NODE_VERSION=22.18.0
PNPM_VERSION=9.15.0
PG_BIN=/usr/lib/postgresql/16/bin

install -d -m 700 "${RUNTIME_ROOT}" "${RUNTIME_ROOT}/logs" "${RUNTIME_ROOT}/pids"

if [[ ! -x ${PG_BIN}/postgres ]]; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq curl ca-certificates xz-utils postgresql-16 postgresql-client-16
fi

VECTOR_CONTROL=/usr/share/postgresql/16/extension/vector.control
if [[ ! -f ${VECTOR_CONTROL} ]] || ! grep -Eq "default_version[[:space:]]*=[[:space:]]*'0\.8\.2'" "${VECTOR_CONTROL}"; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq build-essential git postgresql-server-dev-16
  rm -rf -- /tmp/pgvector-dacai
  git clone --depth 1 --branch v0.8.2 https://github.com/pgvector/pgvector.git /tmp/pgvector-dacai
  make -C /tmp/pgvector-dacai -s
  make -C /tmp/pgvector-dacai -s install
  rm -rf -- /tmp/pgvector-dacai
fi

NODE_ROOT=${RUNTIME_ROOT}/node
if [[ ! -f ${NODE_ROOT}/.dacai-install-complete ]] || [[ ! -x ${NODE_ROOT}/bin/node ]] || [[ $(${NODE_ROOT}/bin/node --version) != v${NODE_VERSION} ]]; then
  archive=node-v${NODE_VERSION}-linux-x64.tar.xz
  install -d -m 755 "${RUNTIME_ROOT}/cache"
  curl -fsSL --retry 4 --retry-delay 3 \
    -o "${RUNTIME_ROOT}/cache/${archive}" \
    "https://nodejs.org/dist/v${NODE_VERSION}/${archive}"
  curl -fsSL --retry 4 --retry-delay 3 \
    -o "${RUNTIME_ROOT}/cache/SHASUMS256.txt" \
    "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt"
  (
    cd "${RUNTIME_ROOT}/cache"
    grep " ${archive}$" SHASUMS256.txt | sha256sum -c -
  )
  rm -rf -- "${NODE_ROOT}"
  install -d -m 755 "${NODE_ROOT}"
  tar --no-same-owner -xJf "${RUNTIME_ROOT}/cache/${archive}" --strip-components=1 -C "${NODE_ROOT}"
  touch "${NODE_ROOT}/.dacai-install-complete"
fi

PNPM_ROOT=${RUNTIME_ROOT}/pnpm
export PATH=${NODE_ROOT}/bin:${PATH}
if [[ ! -x ${PNPM_ROOT}/bin/pnpm ]] || [[ $(${PNPM_ROOT}/bin/pnpm --version) != ${PNPM_VERSION} ]]; then
  rm -rf -- "${PNPM_ROOT}"
  "${NODE_ROOT}/bin/npm" install --global --prefix "${PNPM_ROOT}" "pnpm@${PNPM_VERSION}"
fi
export PATH=${NODE_ROOT}/bin:${PNPM_ROOT}/bin:${PG_BIN}:${PATH}

if [[ ! -s ${DB_CONFIG} ]]; then
  printf 'Missing protected database deployment configuration.\n' >&2
  exit 1
fi

install -d -m 777 "${PG_ROOT}"
runuser -u postgres -- mkdir -p "${PG_ROOT}/backups" "${PG_ROOT}/logs"
chmod 755 "${PG_ROOT}"
install -d -m 700 -o postgres -g postgres "${PG_DATA}"
install -d -m 700 -o postgres -g postgres "${PG_FSYNC_TEST}"
install -d -m 775 -o postgres -g postgres "${PG_SOCKET}"

if [[ ! -f ${PG_ROOT}/.overlay-fsync-verified && ! -f ${PG_ROOT}/.overlay-fsync-unsupported ]]; then
  if runuser -u postgres -- "${PG_BIN}/pg_test_fsync" -f "${PG_FSYNC_TEST}/fsync-test" \
    > "${RUNTIME_ROOT}/logs/pg-test-fsync.log" 2>&1; then
    touch "${PG_ROOT}/.overlay-fsync-verified"
  else
    # Some container overlay drivers reject pg_test_fsync's O_DIRECT variant
    # even though PostgreSQL's normal fsync/WAL path is supported. The deploy
    # still performs an actual transaction, clean restart, and pg_dump below.
    printf 'pg_test_fsync O_DIRECT probe unsupported; using live PostgreSQL durability checks.\n' >&2
    touch "${PG_ROOT}/.overlay-fsync-unsupported"
  fi
fi

if [[ ! -s ${PG_DATA}/PG_VERSION ]]; then
  # Clean up the exact probe file left by the first bootstrap revision. No
  # database files exist until PG_VERSION is present.
  rm -f -- "${PG_DATA}/fsync-test"
  runuser -u postgres -- "${PG_BIN}/initdb" \
    -D "${PG_DATA}" --encoding=UTF8 --locale=C.UTF-8 \
    --auth-local=peer --auth-host=scram-sha-256 >/dev/null
fi

if ! "${PG_BIN}/pg_isready" -h 127.0.0.1 -p 5433 >/dev/null 2>&1; then
  runuser -u postgres -- "${PG_BIN}/pg_ctl" \
    -D "${PG_DATA}" \
    -l "${PG_DATA}/postgres.log" \
    -o "-h 127.0.0.1 -p 5433 -k ${PG_SOCKET}" \
    -w start >/dev/null
fi

python3 - "${DB_CONFIG}" <<'PY' | \
  runuser -u postgres -- "${PG_BIN}/psql" -X -v ON_ERROR_STOP=1 \
    -h "${PG_SOCKET}" -p 5433 postgres >/dev/null
import json
import re
import sys

config = json.load(open(sys.argv[1], encoding='utf-8'))
user = config['username']
password = config['password']
if not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*', user):
    raise SystemExit('Database username is not a safe PostgreSQL identifier.')

def literal(value):
    return "'" + value.replace("'", "''") + "'"

print(f'''DO $dacai$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = {literal(user)}) THEN
    EXECUTE 'ALTER ROLE ' || quote_ident({literal(user)}) || ' LOGIN PASSWORD ' || quote_literal({literal(password)});
  ELSE
    EXECUTE 'CREATE ROLE ' || quote_ident({literal(user)}) || ' LOGIN PASSWORD ' || quote_literal({literal(password)});
  END IF;
END
$dacai$;''')
PY

db_user=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["username"])' "${DB_CONFIG}")
db_name=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["database"])' "${DB_CONFIG}")
if [[ ! ${db_name} =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
  printf 'Database name is not a safe PostgreSQL identifier.\n' >&2
  exit 1
fi

if [[ $(runuser -u postgres -- "${PG_BIN}/psql" -X -At \
  -h "${PG_SOCKET}" -p 5433 postgres \
  -c "SELECT count(*) FROM pg_database WHERE datname = '${db_name}'") == 0 ]]; then
  runuser -u postgres -- "${PG_BIN}/createdb" \
    -h "${PG_SOCKET}" -p 5433 --owner "${db_user}" "${db_name}"
fi

runuser -u postgres -- "${PG_BIN}/psql" -X -v ON_ERROR_STOP=1 \
  -h "${PG_SOCKET}" -p 5433 "${db_name}" \
  -c 'CREATE EXTENSION IF NOT EXISTS vector' >/dev/null

install -m 755 "${APP_ROOT}/deploy/runpod-native/run-ollama.sh" /workspace/ollama/run-ollama.sh

# Restart only the known persistent Ollama service so the one-model/one-request
# VRAM limits above take effect. The app start script brings it back after the
# database restore is complete.
ollama_pid=$(pgrep -x ollama | head -n 1 || true)
if [[ ${ollama_pid} =~ ^[0-9]+$ ]]; then
  ollama_command=$(tr '\0' ' ' < "/proc/${ollama_pid}/cmdline" 2>/dev/null || true)
  if [[ ${ollama_command} == *'/workspace/ollama'* ]]; then
    kill "${ollama_pid}"
    for _ in $(seq 1 60); do
      kill -0 "${ollama_pid}" 2>/dev/null || break
      sleep 0.5
    done
  fi
fi

cd "${APP_ROOT}"
pnpm install --frozen-lockfile --prefer-offline
pnpm build

printf 'DACAIS native dependencies, PostgreSQL, and production assets are ready.\n'
