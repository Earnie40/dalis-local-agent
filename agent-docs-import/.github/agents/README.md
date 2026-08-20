# GitHub Custom Agents

This directory is for GitHub custom-agent definitions such as:

- `adversarial-twin-simulator.agent.md`

These files are different from repository `AGENTS.md` files.

## Difference

`AGENTS.md` files:
- provide hierarchical repository instructions to coding agents
- live at the root or inside code directories
- describe how agents should work on that part of the repository

`.github/agents/*.agent.md` files:
- define named custom GitHub/Copilot-style agents
- describe a particular agent role, specialization, or behavior
- should not be used as a substitute for repository-wide instructions

## Rules

When adding a custom agent:

- give it one clear responsibility
- define its allowed scope
- define what it must not do
- point it to existing execution/permission infrastructure
- avoid granting blanket filesystem/network/shell/database access
- require evidence/verification for claims
- keep security-sensitive agents fail-closed

Do not duplicate the entire root `AGENTS.md` inside each custom agent definition.
