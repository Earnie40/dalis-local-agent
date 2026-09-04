# DACAIS Domain Intelligence — Foundation

Status vocabulary matches [docs/STATUS.md](STATUS.md).

_Last updated: 2026-08-21 (licensed-ingestion and taxonomy pass)._

This document describes the learning/data architecture that lets DacaiAgent develop
specialized competence per domain instead of becoming one undifferentiated corpus.

**What this is:** the domain-intelligence layer — taxonomy, dataset lineage, temporal
integrity, provenance, prediction records, the adapter registry, and the learning-loop
gate — now **persisted and operational**, with `smart-contract` taken end to end as the
first working domain.

**What this is not:** any trained adapter, any live market or chain connection, any
anchored on-chain evidence. See [Not implemented](#not-implemented).

Per-domain progress is tracked on the operational ladder declared in
[taxonomy.ts](../packages/domain-knowledge/src/taxonomy.ts) — the single source of truth,
asserted by tests so status cannot drift:

    REGISTERED -> RAG_ENABLED -> TOOLS_ENABLED -> EVALUATED
    -> TRAINING_DATA_READY -> ADAPTER_TRAINED -> PRODUCTION_APPROVED

**`smart-contract` is EVALUATED. Every other domain is REGISTERED.** No domain is
ADAPTER_TRAINED or PRODUCTION_APPROVED, and a test enforces that.

---

## 1. Why a taxonomy rather than one dataset

Every dataset, prediction, evaluation, and adapter carries a `DomainId`. There is
deliberately no "everything" corpus, because a single blended dataset makes it
impossible to evaluate a domain, retire a bad source, or train a narrow adapter.

Domains are declared in exactly one place —
[packages/domain-knowledge/src/taxonomy.ts](../packages/domain-knowledge/src/taxonomy.ts).

The registry is now grouped by `family` and is exposed at `GET /api/rag/domains`.
The canonical definitions, aliases, classifier hints, modalities, evidence notes,
safety notes, planned adapters, and exact status remain in `taxonomy.ts`.

- Computing: blockchain, smart contracts, computer science, software engineering,
  backend development, and frontend development.
- Life sciences: biology, radiation biology, anatomy and physiology, and psychology.
- Physical sciences and mathematics: mathematics, physics, electromagnetism,
  gravitation and relativity, antimatter physics, chemistry, nuclear chemistry,
  and astrophysics.
- Engineering and built environment: general engineering (with named mechanical,
  electrical, civil, chemical, materials, biomedical, manufacturing, systems,
  control, marine, energy, optical, quantum, nuclear, and other branches), aerospace,
  CAD, BIM, simulation, nanotechnology, metamaterials and cloaking, claytronics,
  nuclear technology, spatial edge technology, spatial systems, robotics, and
  digital twins.
- Human-computer interaction: AR/spatial computing, digital humans, and 3D
  visualization.
- Finance, markets, ecosystem intelligence, and provenance-preserving cross-domain
  reasoning remain separately scoped.

**Status truth:** `smart-contract` is still the only `EVALUATED` domain. Every new
discipline above is `REGISTERED` only: no status implies a corpus, tool, evaluation,
training dataset, trained adapter, production approval, or professional authority.

A test asserts this table cannot drift into overstating itself, and a second test
asserts no domain ever claims ADAPTER_TRAINED or above.

Each domain also declares its native `modalities` (point clouds, depth, geospatial,
audio, telemetry). This is recorded so ingestion does not flatten non-text data into
text when a native representation is the correct one — the schema is in place; no
multimodal ingestion is built.

### Licensed ingestion is now mandatory on the HTTP path

`POST /api/rag/documents` now uses `KnowledgeIngestionService` rather than writing
directly through `RagService`. Each request must carry an explicit license or permission
statement. Empty statements and placeholders such as `unknown`, `unlicensed`,
`proprietary`, and bare `all rights reserved` are rejected because they do not establish
permission. A reviewed SPDX/open-data identifier, public-domain declaration,
`DACAIS-internal-original` local assertion, or explicit authorization grant is required and is
recorded in the ingestion audit. Authorship, ownership, or public availability by itself
is provenance—not permission—and is rejected.

Search now accepts domain, trusted tenant, time, untagged, and bounded-limit scopes.
Caller-supplied tenant identifiers require a server authorizer; without one, the route
fails closed. At the store boundary, an omitted tenant dimension matches global rows
only, never another tenant's rows. Automatic classification uses hints stored in the
taxonomy, requires at least two hits, caps confidence at 0.6, and abstains on a top-score
tie. Human correction remains the authoritative route for ambiguous material.

---

## 2. Knowledge versus weights — enforced, not documented

The mandatory split lives in
[knowledge-policy.ts](../packages/domain-knowledge/src/knowledge-policy.ts):

- **Facts** → retrieval, always. `trainingEligible: false`. Protocol versions, prices,
  deployed addresses, current APIs and regulations all change faster than a fine-tuning
  cycle, and a fact served by RAG can be corrected without retraining.
- **Procedures** → weights. How to analyse a contract, structure a hypothesis, design a
  leak-free evaluation, recover from a failure.

`assertTrainable()` **throws** when a caller tries to route a fact into a training set,
so this is a build error rather than a judgement call.

---

## 3. Provenance — observed, stated, inferred

[provenance.ts](../packages/domain-knowledge/src/provenance.ts) wraps durable claims in
`Claim<T>` carrying an `assertionClass`: `observed`, `stated`, `inferred`, `simulated`,
`predicted`, `estimated`, `confirmed-physical`.

- `asFact()` is the only way to read a claim as fact, and it **refuses** anything that is
  not `observed` or `confirmed-physical`.
- `inferred` / `predicted` / `estimated` claims cannot be constructed without a
  confidence value.
- `combineClaims()` always returns `inferred`, **even when every input was observed** —
  drawing a conclusion is a step the platform took, not something the world reported.
  This is what stops a speculative cross-domain conclusion from hardening into a fact.

Worked example, rendered by `describeTradeEvent()`:

```
OBSERVED: participant wallet:0xabc went long on ETH-USD (large size) at 2026-01-01T00:00:00.000Z; regime trending-up.
STATED: bought the dip
INFERRED (confidence 0.35): liquidity expansion may also have contributed
```

---

## 4. Temporal integrity — the look-ahead defence

Every observation carries three timestamps, and they are not interchangeable:

| Field | Meaning |
| --- | --- |
| `eventTime` | when it happened in the world |
| `availableAt` | earliest moment the information could legitimately be known |
| `observedAt` | when this platform recorded it |

`assertTemporalOrder()` enforces `eventTime <= availableAt <= observedAt`.

**Backtests and training examples filter on `availableAt`, never on `eventTime`.** That
is the whole point: an earnings figure is *about* Monday but is not knowable until
Thursday, and a model trained on it as of Monday learns to see the future.

`assertNoLookAhead()` throws and **names every leaked record** rather than filtering
silently — a leak in a backtest input set is a defect to fix, not a row to drop.

Splits ([splits.ts](../packages/datasets/src/splits.ts)) are strictly ordered in time —
train, then validation, then test — separated by an embargo that must be at least as long
as the longest label horizon. Records landing in an embargo gap are excluded; that gap is
the point, not an inconvenience.

---

## 5. Dataset lineage

[lineage.ts](../packages/datasets/src/lineage.ts). A dataset version is immutable once
published (re-registering with a different content hash throws), must declare at least
one source, and records what it derived from. The lineage graph refuses cycles.

`resolvedSources()` returns every source feeding a version **including inherited ones** —
the query a licensing or authorization review actually needs, and the one that lets a
mislicensed source be followed forward to every artifact that inherited it.

`DatasetSource.authorizationRef` marks sources that required explicit permission. There
is no field for private account data, because it must not be collected.

---

## 6. The learning loop — nothing jumps to training

[learning-loop.ts](../packages/datasets/src/learning-loop.ts) is an explicit state machine:

```
OBSERVE → RETRIEVE → ANALYZE → HYPOTHESIZE → SIMULATE → COMPARE →
STORE_EXPERIENCE → QUALITY_REVIEW → TRAINING_CANDIDATE → APPROVAL →
DATASET → FINE_TUNE → EVALUATE → PROMOTED | REJECTED
```

Enforced:

- Stages advance **one at a time**. `advanceTo('dataset')` from `observe` throws.
- Entering `APPROVAL` requires a named human actor. Automated approval is refused.
- `promote()` is reachable only from `EVALUATE`, only with a passing evaluation and a
  named actor.
- `reject()` is available from any non-terminal stage and retains the reason.

---

## 7. Market intelligence

**Research only.** No signal generation, no ordering instruction, no execution authority.

- **Trader research** ([trader-research.ts](../packages/market-intelligence/src/trader-research.ts)) —
  participants are pseudonymous by default; attaching a real-world name without cited
  public evidence throws. Size is a **class**, not a notional, because the research
  question is behavioural and raw size invites mirroring. Stated and inferred rationale
  are separate fields that cannot collapse into one another.
- **Predictions** ([predictions.ts](../packages/market-intelligence/src/predictions.ts)) —
  records are frozen and content-hashed at creation. A probability of exactly 0 or 1 is
  refused as a certainty claim; a forecast with no invalidating condition is refused as
  unfalsifiable. Outcomes are separate records bound to the `predictionHash`, so the
  system cannot rewrite its forecast history once results are known.
- **Scoring** — Brier score, calibration bins, directional accuracy, and
  `falseConfidenceRate` (which catches a model that is wrong precisely where it was
  surest). Invalidated forecasts are **excluded**, not counted wrong — scoring them would
  punish honest condition-setting.
- **Backtesting** ([backtest.ts](../packages/market-intelligence/src/backtest.ts)) —
  walk-forward windows with embargo, and a cost model that refuses to be constructed
  without explicit fee, slippage, latency, and participation assumptions. A zero-cost
  backtest is the most common way a strategy looks profitable and is not.

---

## 8. Adapter registry

[adapters.ts](../packages/model-registry/src/adapters.ts). **No adapter has been
trained.** The registry and promotion gate exist so adapters can be added later without
reshaping the dataset, evaluation, or evidence layers.

Promotion requires *all* of: candidate status, a matching evaluation for the same
adapter and domain, a score above threshold, no general-capability regression beyond
threshold, a named human approver, and a `trainingRunHash`. Failures are reported
together so a rejected promotion explains itself. An unpromoted adapter is never routable.

---

## 9. Evidence anchoring

[evidence.ts](../packages/domain-knowledge/src/evidence.ts) computes content hashes over
canonical (key-sorted) JSON for the ten DACAIS evidence kinds — `sourceHash`,
`datasetHash`, `predictionHash`, `trainingRunHash`, `modelAdapterHash`, `approvalHash`,
and so on.

**Raw data stays off-chain; only digests are recorded.** `anchoredTxHash` is undefined on
every anchor this repository produces, because nothing here submits to a chain. A test
asserts that.

---

## Operational state (this pass)

### Domain-scoped retrieval — LIVE VERIFIED

Migration 013 extends the **existing** `knowledge_documents` / `knowledge_chunks` tables.
There is exactly one pgvector corpus in this platform; domain scoping is a filter on it,
not a second store. `domain_id` is denormalized onto the chunk so the vector scan narrows
before joining.

`RetrievalScope` gained `domainIds`, `organizationId`, `includeUntaggedDomain`, and
`asOf`. Omitting `domainIds` reproduces the previous behaviour exactly. An unknown domain
**throws** rather than matching nothing — a typo returning zero rows is indistinguishable
from an empty corpus.

Live proof (`node --import tsx scripts/rag-domain-proof.mjs`), same query three ways:

```
QUERY: What authorization is required before ALPHA can settle?

scoped to smart-contract -> [0.3057] DACAIS Smart Contract Test Knowledge  (SETTLER_ROLE)
                            license=DACAIS-internal-original sha256=b1488c2a1401…
scoped to robotics       -> (no results)
cross-domain (explicit)  -> finds it
unscoped                 -> unchanged behaviour
invalid DomainId         -> rejected

ALL CHECKS PASSED
```

### Ingestion — LIVE VERIFIED

`KnowledgeIngestionService` implements the required flow:

    source -> validation -> secret redaction -> normalization -> hashing ->
    provenance -> domain assignment -> chunking -> embedding -> storage

Formats: `txt`, `md`, `json`, `code`. Redaction runs **before** hashing and embedding, so
a secret never reaches the vector store or an embedding request. A licence is mandatory —
unknown provenance is refused, because "unknown" is not "permitted". The lowest write
boundary recomputes SHA-256 from the exact normalized content and requires a stable source
ID, so a caller cannot attach an arbitrary digest. Duplicate detection is exact-provenance
and tenant scoped. Every attempt writes a `knowledge_ingestions` row, including
rejections, so a silently dropped ingestion is not indistinguishable from one that never
happened.

Automatic domain classification exists but is deliberately weak and capped at 0.6
confidence; an explicit `domainId` always wins, and `assignedDomain` /
`classificationMethod` / `classificationConfidence` are stored so a human can correct it
(`correctDomain()`).

There is **no crawler and no unrestricted scraping**.

### Persistence — LIVE VERIFIED

Migrations 012 through 022 are applied. Migrations 020–022 quarantine knowledge without
a validated, locally bound rights basis and stable source provenance. Stores:
`DatasetStore`, `TrainingCandidateStore`,
`MarketStore`, `AdapterRegistryStore`, `EvidenceStore`. 25 database-backed tests pass
against the real instance.

Invariants are enforced in three places — types, store, and CHECK constraint — because
each catches a different mistake. Two are proven to survive a **direct SQL write**:

```
training_candidates_eligible_requires_approval   -- eligible needs human + evidence
market_predictions_probability_range             -- 0 or 1 claims certainty
```

---

## The smart-contract domain (first complete domain)

**Status: EVALUATED.** Not TRAINING_DATA_READY, not ADAPTER_TRAINED.

### Corpus — RAG knowledge, never training data

Nine documents in [corpus/smart-contract/](../corpus/smart-contract/), **originally
authored for DACAIS**, so there is no third-party licence to honour and no attribution
ambiguity. No proprietary third-party code was ingested.

Every document carries source, licence (`DACAIS-internal-original`), sha256, `domainId`,
`ingestedAt`, and provenance. `training_eligible = false` on all of them, asserted by test.

### Analysis path — TEST VERIFIED + LIVE VERIFIED

[packages/smart-contract](../packages/smart-contract). Source-code analysis only: it never
deploys, never sends a transaction, and never targets a remote address.

**Registered as agent tools.** `smartcontract.analyze` and `smartcontract.report` are in
the tool registry at tier `safe`, requiring no write, shell, or network capability. They
resolve the `.sol` path through `resolveWithinWorkspace()` before any I/O, report
workspace-relative paths (an absolute path leaks host layout), and expose **no address,
rpcUrl, or chainId parameter** — targeting a remote deployed contract is not a capability
they have, and a test asserts the schema cannot grow one. They appear in a run when the
prompt is contract-related or when explicitly requested.

`parser.ts` is a small structural reader — it strips comments and strings preserving line
numbers, then brace-matches function bodies. **It is not a compiler front end**, and that
limitation is reported with every analysis rather than hidden.

Every finding carries `status: 'confirmed' | 'possible'`, keeping **observed fact separate
from inference** as a required field rather than a matter of wording, plus severity and a
*separate* confidence, remediation, and a suggested defensive test.

Live proof (`node --import tsx scripts/smart-contract-analysis-proof.mjs`):

```
[AC-1] HIGH · CONFIRMED · confidence 0.70
  `setTreasury` is externally callable with no access control
  OBSERVED:  Function `setTreasury` is external, changes state, and carries no modifier.
  INFERRED:  Any address appears able to change privileged configuration.
  REMEDIATE: Restrict to the role that should hold this authority…
  TEST:      Assert a call from an unprivileged address reverts…
  SUPPORT:   Access Control, Ownership, and Roles (DACAIS-internal-original · 3c70d5315d47…)

[RE-2] HIGH · CONFIRMED · confidence 0.80
  `withdraw` writes state after an external call
  …
ALL CHECKS PASSED  (11 checks)
```

### Held-out evaluation — TEST VERIFIED

Twelve cases in [fixtures/contracts/](../fixtures/contracts/), **never ingested** — a gate
asserts zero fixtures are present in the knowledge store. Scoring a system on material it
has memorised measures recall of the corpus, not capability.

```
TP=13  FP=0  FN=0
precision=100.0%  recall=100.0%  f1=100.0%
severity accuracy=100.0%  clean-contract accuracy=100.0%

  access-control + reentrancy    100%   unsafe external-call handling  100%
  signature / replay             100%   denial of service              100%
  oracle manipulation            100%   token accounting / invariants  100%
  proxy / initializer            100%   recognize a safe contract      3 clean, 0 FP
  authorization                  100%
```

The suite deliberately includes **three safe contracts**, because a tool that cannot
recognise correct code is not usable — over-reporting trains a reviewer to skim.

> **Read this number honestly.** It is a **12-case suite against a deterministic
> analyzer, and the detectors remain aligned with the fixtures.** It demonstrates the
> evaluation *harness* works and guards against regression. It is **not** evidence of
> general smart-contract review capability, and it says nothing about an LLM's ability —
> no model is involved in the analyzer at all. A meaningful number needs many more cases
> written by someone other than the detector author.
>
> The suite has already earned its keep twice. Adding `FeeOnTransferVault` exposed a
> defect class with **no detector at all** (token accounting, recall 0%), which is why
> that detector now exists. And a finding first recorded as a false positive turned out
> to be **correct** — `transferFrom` before a state update is a real CEI violation with
> callback-capable tokens — so the expectation was wrong, not the analyzer.

Two false positives were found and fixed during this pass, both real precision bugs:
a self-service `withdraw()` flagged as missing access control (users withdrawing their
own balance are correctly permissionless), and double-reporting where a *defective* guard
(`tx.origin`, a replayable signature) also triggered a "no access control" finding.

---

## Adapter training gates — BLOCKED, nothing trained

`node --import tsx scripts/adapter-training-gates.mjs` — **8/11 pass**:

```
PASS  ingestion · DomainId-scoped RAG · provenance · persistence ·
      smart-contract evaluation · held-out separation · secret redaction · model registry

FAIL  approved training candidates    0 approved — approval is a human action, not performed
FAIL  immutable dataset version       0 candidates sealed into a dataset version
FAIL  resource gate                   Free RAM 1.1 GiB is below the required 4.0 GiB headroom
```

The resource gate is now **implemented** ([resource-gate.ts](../packages/model-registry/src/resource-gate.ts))
and blocking on a real measurement rather than on absence. It is fail-closed in the way
that matters: an unmeasurable resource counts as unavailable, never as sufficient —
"I could not measure VRAM" blocks a GPU run, because the alternative is discovering the
answer by crashing. It also refuses to start while inference models still hold VRAM.

**No fine-tuning was attempted, and `gpu_coder/qwen3-coder:30b` was not touched.** Two of
the three failures are the design working: training data requires a human approval that
has not happened. The third is genuinely missing infrastructure.

---

## Not implemented

Named explicitly so this is not mistaken for a finished system:

- **No trained adapter.** No LoRA/QLoRA run, no adapter serving. Gates block it.
- **No live market or chain connection.** No RPC, indexer, market-data, order-book, or
  news ingestion. The market tables have stores and tests but no live feed.
- **No LLM in the analysis path.** The analyzer is deterministic static analysis. The
  agent loop is not yet wired to it, so there is no measurement of model reasoning about
  contracts.
- **No PDF / DOCX / CSV / HTML ingestion.** Only txt, md, json, and source code.
- **No executable contract testing.** Suggested defensive tests are *recommended text*;
  nothing compiles or runs Solidity. No Foundry/Hardhat integration.
- **No multimodal ingestion.** Modalities are declared; no image, video, depth, point
  cloud, or telemetry pipeline exists.
- **No robotics, AR, digital-human, or digital-twin subsystems.** Taxonomy entries only.
  Training/simulation capability is **not** authorization for physical execution.
- **No on-chain anchoring.** Hashes are computed and stored; `anchored_tx_hash` is always
  NULL and nothing submits to a chain.

## Suggested next steps

1. Add an **LLM-in-the-loop** evaluation variant, so what is measured is the agent's
   reasoning over the tool output rather than the deterministic analyzer alone. This is
   the largest remaining gap in what the numbers mean.
2. Have someone other than the detector author write evaluation cases.
3. Generate training candidates from real agent traces, then seek human approval — the
   last two blocked training gates are both waiting on that.
4. Consider Foundry/Hardhat integration so suggested defensive tests can actually be
   compiled and run rather than recommended as text.
