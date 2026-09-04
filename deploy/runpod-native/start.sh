#!/usr/bin/env bash
set -Eeuo pipefail

APP_ROOT=${DACAI_REMOTE_APP_ROOT:-/workspace/dacai-app}
RUNTIME_ROOT=${DACAI_RUNTIME_ROOT:-/workspace/dacai-runtime}
PG_ROOT=${DACAI_PG_ROOT:-/workspace/dacai-postgres}
PG_DATA=${DACAI_PG_DATA:-/var/lib/postgresql/dacai}
PG_SOCKET=/var/run/postgresql
PG_BIN=/usr/lib/postgresql/16/bin
LOG_ROOT=${RUNTIME_ROOT}/logs
PID_ROOT=${RUNTIME_ROOT}/pids
NODE_BIN=${RUNTIME_ROOT}/node/bin
PNPM_BIN=${RUNTIME_ROOT}/pnpm/bin

export PATH=${NODE_BIN}:${PNPM_BIN}:${PG_BIN}:${PATH}

install -d -m 700 "${LOG_ROOT}" "${PID_ROOT}"

if ! "${PG_BIN}/pg_isready" -h 127.0.0.1 -p 5433 >/dev/null 2>&1; then
  runuser -u postgres -- "${PG_BIN}/pg_ctl" \
    -D "${PG_DATA}" \
    -l "${PG_DATA}/postgres.log" \
    -o "-h 127.0.0.1 -p 5433 -k ${PG_SOCKET}" \
    -w start >/dev/null
fi

if ! curl -fsS --max-time 3 http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then
  setsid /workspace/ollama/run-ollama.sh \
    > "${LOG_ROOT}/ollama.log" 2>&1 < /dev/null &
  for _ in $(seq 1 60); do
    curl -fsS --max-time 2 http://127.0.0.1:11434/api/tags >/dev/null 2>&1 && break
    sleep 1
  done
fi
curl -fsS --max-time 3 http://127.0.0.1:11434/api/tags >/dev/null

media_ready() {
  curl -fsS --max-time 3 http://127.0.0.1:8090/v1/health 2>/dev/null | \
    python3 -c 'import json,sys; body=json.load(sys.stdin); raise SystemExit(0 if body.get("backdropModel") else 1)' 2>/dev/null
}

if ! curl -fsS --max-time 3 http://127.0.0.1:8090/v1/health >/dev/null 2>&1; then
  setsid /workspace/dacais-media/run-media.sh \
    > "${LOG_ROOT}/media.log" 2>&1 < /dev/null &
fi
for _ in $(seq 1 300); do
  media_ready && break
  sleep 1
done
media_ready

stop_managed_process() {
  local pid_file=$1
  local expected=$2
  local pid=''
  local command=''
  if [[ ! -f "${pid_file}" ]]; then return 0; fi
  read -r pid < "${pid_file}" || true
  if [[ "${pid}" =~ ^[0-9]+$ ]] && kill -0 "${pid}" 2>/dev/null; then
    command=$(tr '\0' ' ' < "/proc/${pid}/cmdline" 2>/dev/null || true)
    if [[ "${command}" == *"${expected}"* ]]; then
      kill "${pid}" 2>/dev/null || true
      for _ in $(seq 1 30); do
        kill -0 "${pid}" 2>/dev/null || break
        sleep 0.2
      done
    fi
  fi
  rm -f -- "${pid_file}"
}

stop_managed_process "${PID_ROOT}/server.pid" 'apps/server'
stop_managed_process "${PID_ROOT}/web.pid" 'vite'

cd "${APP_ROOT}"
setsid pnpm --filter @dacai-local-agent/server exec tsx src/index.ts \
  > "${LOG_ROOT}/server.log" 2>&1 < /dev/null &
echo $! > "${PID_ROOT}/server.pid"

for _ in $(seq 1 180); do
  curl -fsS --max-time 2 http://127.0.0.1:3101/health >/dev/null 2>&1 && break
  if ! kill -0 "$(cat "${PID_ROOT}/server.pid")" 2>/dev/null; then
    tail -n 80 "${LOG_ROOT}/server.log" >&2
    exit 1
  fi
  sleep 1
done
curl -fsS --max-time 5 http://127.0.0.1:3101/health >/dev/null

setsid env DACAI_API_PROXY_TARGET=http://127.0.0.1:3101 \
  pnpm --filter @dacai-local-agent/web exec vite preview \
  --host 127.0.0.1 --port 4173 \
  > "${LOG_ROOT}/web.log" 2>&1 < /dev/null &
echo $! > "${PID_ROOT}/web.pid"

for _ in $(seq 1 60); do
  curl -fsS --max-time 2 http://127.0.0.1:4173/ >/dev/null 2>&1 && break
  if ! kill -0 "$(cat "${PID_ROOT}/web.pid")" 2>/dev/null; then
    tail -n 80 "${LOG_ROOT}/web.log" >&2
    exit 1
  fi
  sleep 1
done
curl -fsS --max-time 5 http://127.0.0.1:4173/ >/dev/null

printf 'DACAIS native stack ready (web 4173, API 3101, PostgreSQL 5433, Ollama 11434, media 8090).\n'
