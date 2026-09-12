# DACAIS Local Agent Tool Instructions

You have access to a structured engineering tool layer.

Tool root:

agent-tools/

Primary dispatcher:

agent-tools/tools/Invoke-DacaiTool.ps1

Machine-readable registry:

agent-tools/tool-registry.json

Authorization configuration:

agent-tools/policy/authorization.json

## Tool Selection

Select tools according to objective rather than guessing from names.

Examples:

Windows process/service state
→ windows-diagnostics

Windows network state
→ network-diagnostics

Linux/WSL state
→ wsl-diagnostics

Authorized network discovery
→ nmap-authorized

Authorized remote server diagnostics
→ ssh-readonly

Find files or locate text on this machine
→ local-find

Passive public-record lookup (DNS / reverse DNS / whois)
→ osint-lookup

## Before Execution

Determine:

- objective
- target
- authorization
- expected observation
- risk
- whether execution changes state

Prefer read-only inspection.

## After Execution

Evaluate:

- what was actually observed
- whether evidence supports the hypothesis
- whether additional evidence is required
- whether the original goal is satisfied

## Tool Calling

Example:

powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File agent-tools/tools/Invoke-DacaiTool.ps1 `
  -Tool network-diagnostics

Example authorized discovery:

powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File agent-tools/tools/Invoke-DacaiTool.ps1 `
  -Tool nmap-authorized `
  -Target 192.168.1.1 `
  -Mode Discovery

Never bypass the allowlist.

Example local find (files by name, then text inside them):

powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File agent-tools/tools/Invoke-DacaiTool.ps1 `
  -Tool local-find `
  -Path C:\Users\Kyleh\DacaiLocalAgent `
  -Name *.ts `
  -Content "streamAgent"

Example passive lookup:

powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File agent-tools/tools/Invoke-DacaiTool.ps1 `
  -Tool osint-lookup `
  -Target example.com

local-find is read-only and never touches the network. osint-lookup is
passive (public records only) and stays inside the authorization allowlist;
neither locates or tracks individuals.


---

## Autonomous Reasoning Loop

For any non-trivial engineering task use:

agent-tools/reasoning/Invoke-DacaiReasoningLoop.ps1

Required lifecycle:

Start
→ Observe
→ Hypothesis
→ Plan
→ ToolCall
→ Verify

If verification fails:

Replan
→ ToolCall
→ Verify

Only call Complete after verification passes.

Every tool output is evidence, not proof of success.

When the problem is unfamiliar, reason from observable state and
available capabilities rather than requiring a pre-written workflow.

Never fabricate unavailable tools or observations.

Use concise decision records instead of storing private
chain-of-thought.

