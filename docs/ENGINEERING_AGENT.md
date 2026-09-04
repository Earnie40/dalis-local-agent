# DACAIS Engineering Agent — Tool Layer V1

_Status: implemented foundation; external CAD/BIM/rendering backends are not installed
on the current host._

This milestone turns the engineering roadmap into registered, permissioned tool
surfaces without claiming unavailable applications work. Every model call still follows
the existing path:

```
model plan -> tool request -> workspace capability check -> permission/approval
-> fixed adapter -> bounded process -> artifact hash/validation evidence -> model review
```

## What works now

- Repository symbols, references, callers, callees, impact analysis, and bounded
  `code.path.trace` queries.
- Imported TypeScript/JavaScript function calls become cross-file `CALLS` edges on the
  next repository reindex.
- Path results include file/line evidence, search limits, static-analysis limitations,
  and Mermaid or DOT graph source. Graphviz is optional for rendering.
- `engineering.capabilities.inspect` checks a fixed backend catalog and returns
  `verified`, `unsupported`, or `unknown` without leaking executable paths.
- `engineering.artifact.inspect` verifies workspace containment and records byte size,
  format, and SHA-256 for up to 50 artifacts.
- Domain-aware, licensed knowledge ingestion and search for computing, mathematics,
  physical and life sciences, and engineering disciplines.

## Permissioned external-adapter surfaces

| Tool | Tier | Backends | Boundary |
| --- | --- | --- | --- |
| `engineering.capabilities.inspect` | safe | fixed catalog | Requires shell capability for fixed local probes |
| `engineering.artifact.inspect` | safe | files | Read-only, workspace-contained hashes; no geometry/physics claim |
| `cad.execute` | high-impact | CadQuery, FreeCAD, OpenSCAD | Disabled by default; requires write + shell + approval + configured OS sandbox |
| `bim.execute` | high-impact | IfcOpenShell | Disabled by default; requires write + shell + approval + configured OS sandbox |
| `scene.render` | high-impact | Blender | Disabled by default; requires write + shell + approval + configured OS sandbox |

The execution surfaces accept a workspace-relative source path, a closed backend enum,
a source SHA-256 bound to approval, and declared new output paths. The tool boundary
contains/canonicalizes those paths, rejects duplicates and overwrites, and requires every
declared output to be present and hashed after exit zero. Authored Python/SCAD scripts are
still code execution, so these tools are intentionally `high-impact`.

Production execution currently refuses every authored script. An operator must supply an
OS-level sandbox adapter that confines filesystem and network access and uses only fixed,
trusted executables with `shell:false` argv before any backend can run. Test fakes verify
the contract; they are not evidence that a live CAD/BIM/render job ran.

Artifact presence and hashing prove which bytes were produced. They do **not** prove a
solid is manifold, an IFC model is code-compliant, a simulation is physically valid, or
a design is safe/certified. Those require backend-specific validators, tests, applicable
standards, and qualified professional review.

## Backend catalog and current machine

Foundation catalog entries cover the internal repository graph, Graphviz, Tree-sitter,
ts-morph, CodeQL/Joern, CadQuery, FreeCAD, OpenSCAD, IfcOpenShell/IfcConvert, and Blender.
Later entries reserve the same abstraction for Honeybee/EnergyPlus, CalculiX,
OpenFOAM, Code_Aster, OpenSeesPy, OpenModelica, Project Chrono, ROS 2, Gazebo,
Isaac Sim, MuJoCo, PX4, and ArduPilot.

Observed on 2026-08-21: Python is present. CadQuery, IfcOpenShell, Blender Python,
Honeybee, FreeCADCmd, Blender, OpenSCAD, Graphviz, CodeQL, and Joern were not found.
Only the internal repository-graph capability can therefore be claimed as available
from this bundle today. Unit tests use deterministic fakes for unavailable processes;
there is no fabricated live CAD/BIM/render result.

## Knowledge breadth and epistemic boundaries

The taxonomy now registers computer science, backend/frontend/software engineering,
mathematics and calculations, biology, chemistry, anatomy/physiology, psychology,
physics, electromagnetism, astrophysics, aerospace, nanotechnology, nuclear sciences,
antimatter, gravitation, metamaterials/cloaking, claytronics, spatial edge technology,
defensive intelligence/surveillance technology, CAD, BIM, visualization, simulation,
and general engineering branches.

Registration is an address for licensed corpora, tools, datasets, and evaluation—not
embedded expertise. Anti-gravity, general macroscopic cloaking, and large-scale
claytronics claims are explicitly separated into established, experimental, simulated,
or speculative evidence. Nuclear and surveillance-related domains carry peaceful,
lawful, defensive, privacy, safeguards, and professional-review boundaries.

## Next verified milestones

1. Install one backend at a time, beginning with CadQuery, then execute and retain a
   parametric source model, STEP/STL output, and independent geometric validation.
2. Add FreeCAD validation/conversion and Blender presentation rendering.
3. Add IfcOpenShell with a held-out IFC fixture suite before marking BIM tools enabled.
4. Replace heuristic symbol extraction with ts-morph/Tree-sitter and add deeper
   CodeQL/Joern dataflow only after their live probes and test fixtures pass.
5. Ingest separately licensed corpora per domain; mark `RAG_ENABLED` only after scoped
   retrieval proof, and `EVALUATED` only after a held-out suite has actually run.
