-- Cached capability probe results.
--
-- A probe costs one inference call, so results are cached per
-- {provider instance, model, probe version} with a TTL. Cache misses are
-- resolved lazily on first use — never on the boot path.

CREATE TABLE IF NOT EXISTS provider_capabilities (
  provider_instance_id TEXT NOT NULL,
  model                TEXT NOT NULL,
  probe_version        INTEGER NOT NULL,
  -- verified | declared | unsupported | unknown
  tool_calling  TEXT NOT NULL CHECK (tool_calling IN ('verified','declared','unsupported','unknown')),
  streaming     TEXT NOT NULL CHECK (streaming    IN ('verified','declared','unsupported','unknown')),
  -- How a verified call was actually delivered. Several Ollama models emit a
  -- correct {"name","arguments"} object as message text rather than populating
  -- tool_calls; that path works but is more fragile, so it is recorded.
  tool_call_channel TEXT CHECK (tool_call_channel IS NULL OR tool_call_channel IN ('structured','text-json')),
  context_window     INTEGER,
  max_output_tokens  INTEGER,
  -- Error class only; never a response body that might echo a credential.
  last_probe_error   TEXT,
  probed_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (provider_instance_id, model, probe_version)
);

CREATE INDEX IF NOT EXISTS provider_capabilities_probed_idx ON provider_capabilities (probed_at DESC);
