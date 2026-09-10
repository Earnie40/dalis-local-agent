---
name: capability-research
description: Determine unknowns, obtain authoritative knowledge, select or build the smallest appropriate tool, and verify results for unfamiliar or underspecified requests, including vehicle diagnostics and connectivity.
metadata:
  tags: [reasoning, research, discovery, tools, capability, unknowns, requirements, protocol, adapter, obd, vehicle, automotive, bluetooth, onstar, diagnostics, telematics]
---
# Capability Research and Reasoning

Use this skill when the objective includes an unfamiliar device, service, API,
protocol, workflow, or tool. The goal is to turn an unknown into an
evidence-backed next action, not to guess a procedure or hard-code an assumed
integration.

## Core reasoning loop

1. State the requested outcome and its observable success condition. Separate
   facts supplied by the user from facts that still need observation.
2. Build an interface map before selecting a tool. Distinguish the physical or
   local device, the transport, the vendor/OEM service, the account or
   entitlement surface, and the application integration point.
3. List concrete unknowns: identity/version, host platform, hardware present,
   protocol or SDK, account/service prerequisites, available tools, and the
   exact result the user needs.
4. Gather the highest-information evidence first. Prefer a direct local
   observation, a versioned primary source, or an official SDK/manual over a
   search snippet, forum claim, or memory.
5. Compare the evidence with the interface map. Mark each conclusion as
   observed, documented, inferred, or still unknown; do not promote an
   inference into an observed capability.
6. Select the smallest existing tool whose documented inputs and outputs can
   resolve the next unknown. If none exists, write a narrow adapter/tool
   contract before implementation: platform, discovery input, required SDK or
   driver, inputs, outputs, failure modes, non-destructive capability probe,
   and validation fixture. When the task authorizes software changes, implement
   and register that smallest adapter, test its failure modes, and run the probe;
   do not stop at a proposal while the necessary build and validation tools are
   available.
7. Make a dependency-ordered plan: identify -> observe -> verify contract ->
   integrate -> validate. Replan only the disproven branch when an observation
   conflicts with a hypothesis.
8. Finish with an evidence ledger containing source, revision/date, scope,
   result, uncertainty, missing prerequisite, and the next highest-value
   action.

## Unknown-recovery rule

When the requested result is clear but the procedure is not, do not repeat a
rejected action record or turn uncertainty into a final answer:

1. Name the smallest missing fact that separates the current state from the
   next observable step.
2. Bind the next action to one unresolved requested output. Assess the exact
   candidate tool already proposed; do not silently substitute a different
   tool in the reasoning record.
3. Prefer a task-related, read-only discovery action first. A successful skill
   lookup, repository search, public-source lookup, device scan, or status
   inspection is procedural progress even when it cannot prove the final
   empirical outcome.
4. Translate the discovered procedure into the smallest non-destructive probe,
   observe the result, and revise only the disproven branch.
5. Treat malformed control JSON as a formatting failure, not proof that the
   task is impossible. Correct it once; if it remains malformed, continue only
   with a registered read-only discovery action whose subject matches the
   unresolved request. Mutation and completion still require their normal
   authorization and evidence.

## Discovery routes

Use the route that can actually answer the unknown:

- `skills.find` then `skills.read` for an installed procedure.
- Repository architecture and symbol search for an existing local integration.
- Public-web search followed by the source page for external products, APIs,
  standards, SDKs, and hardware manuals.
- Existing tool descriptions and schemas to determine whether a tool can
  produce the required evidence.
- Bounded external-API discovery only after observed contract mismatch.
- A small adapter or MCP/tool implementation only after the device, SDK,
  protocol, and validation surface are identified; first reuse the repository's
  tool interfaces, registration path, tests, and permission model.

Do not treat a missing tool as proof that a capability is impossible. Identify
the missing layer and the smallest testable capability needed to close it.

## Vehicle and connected-service research

For vehicle tasks, identify the exact vehicle, market, model year, powertrain,
adapter make/model/firmware, host platform, and requested outcome before
assuming the interface. A VIN or model name is a lookup cue, not proof of
installed modules, subscriptions, service eligibility, or an available
protocol.

Classify the request before researching it:

| Surface | What to establish |
| --- | --- |
| Direct OBD port | Connector/vehicle applicability, adapter, host connection, and whether the requested data is standardized diagnostic data or OEM-specific. |
| USB, serial, Wi-Fi, Bluetooth, or BLE adapter | Exact adapter documentation, firmware, transport, pairing/discovery behavior, and supported SDK/protocol. Bluetooth is a transport, not a universal OBD protocol. |
| OEM service/diagnostic information | The manufacturer’s documented service-information or diagnostic route for that vehicle and market. |
| Connected-vehicle service | Official owner app, account/plan/consent state, documented developer API, and approved business/contact route where a public interface is absent. |

Source order for this domain:

1. Vehicle owner documentation and the adapter manufacturer’s current manual,
   SDK, or support site.
2. OEM service/developer documentation for the exact vehicle/service.
3. Current standards publishers and regulators for generic OBD or wireless
   transport scope.
4. Maintained libraries only after their supported device/version matrix is
   checked against primary sources.
5. A vendor support or developer-contact route when the needed surface is not
   publicly documented.

Useful authoritative starting points include the [NHTSA vPIC decoder](https://vpic.nhtsa.dot.gov/decoder/), [ISO 15031-3](https://www.iso.org/standard/84210.html), [SAE OBD standards](https://saemobilus.sae.org/topics/electrical-electronics-and-avionics/on-board-diagnostics-obd), the [Bluetooth Core specifications](https://www.bluetooth.com/specifications/specs/), [GM vehicle support](https://experience.gm.com/support/vehicle), [ACDelco TDS](https://www.acdelcotds.com/subscriptions), [OnStar’s vehicle app](https://www.onstar.com/features/all-apps/vehicle-app), and [GM Developers API & Data Services](https://developer.gm.com/docs/api-data-services). Check current applicability and terms on the fetched page; links are starting points, not proof that a specific vehicle or account supports an action.

## Required output when the answer is not yet known

Return a compact capability brief:

```text
Goal and success condition:
Observed facts:
Interface map:
Primary sources checked:
Known / inferred / unknown:
Existing tool or missing adapter contract and implementation path:
Ordered next action and validation:
Blocker or vendor/contact path, if any:
```

This workflow provides a path to find out how to proceed without pretending
that an undocumented interface, adapter behavior, account state, or tool
already exists.
