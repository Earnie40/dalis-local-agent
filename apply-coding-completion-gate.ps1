param(
    [string]$RepoRoot = "C:\Users\Kyleh\DacaiLocalAgent"
)

$ErrorActionPreference = "Stop"

Set-Location $RepoRoot

$agentLoopPath = Join-Path $RepoRoot "packages\agent-core\src\agent-loop.ts"
if (-not (Test-Path $agentLoopPath)) {
    throw "Could not find $agentLoopPath"
}

$routeMatch = Get-ChildItem (Join-Path $RepoRoot "apps\server\src") -Recurse -Filter *.ts |
    Select-String -SimpleMatch "/api/agent/stream" |
    Select-Object -First 1

if (-not $routeMatch) {
    throw "Could not locate the server route containing /api/agent/stream"
}

$routePath = $routeMatch.Path

Write-Host "Agent loop: $agentLoopPath"
Write-Host "Agent route: $routePath"

Copy-Item $agentLoopPath "$agentLoopPath.bak-before-completion-gate" -Force
Copy-Item $routePath "$routePath.bak-before-completion-gate" -Force

function Replace-Once {
    param(
        [string]$Text,
        [string]$Old,
        [string]$New,
        [string]$Label
    )

    $index = $Text.IndexOf($Old, [System.StringComparison]::Ordinal)
    if ($index -lt 0) {
        throw "Could not find expected block for: $Label"
    }

    return $Text.Substring(0, $index) + $New + $Text.Substring($index + $Old.Length)
}

# ---------------------------------------------------------------------------
# 1. Add an explicit completion-signal option to AgentLoopOptions.
# ---------------------------------------------------------------------------

$loop = Get-Content $agentLoopPath -Raw

if ($loop -notmatch 'completionSignalRequired\?: boolean;') {
    $needle = @'
  /**
   * Refuses a final answer until the model has actually inspected evidence.
   */
  evidenceRequirement?: {
'@

    $replacement = @'
  /**
   * When true, a no-tool response is not accepted as task completion unless
   * the model explicitly emits TASK_COMPLETE: or TASK_BLOCKED:.
   *
   * This is intended for autonomous execution roles. It prevents progress
   * narration from being mistaken for a completed task.
   */
  completionSignalRequired?: boolean;

  /**
   * Refuses a final answer until the model has actually inspected evidence.
   */
  evidenceRequirement?: {
'@

    $loop = Replace-Once $loop $needle $replacement "AgentLoopOptions completionSignalRequired"
}

# ---------------------------------------------------------------------------
# 2. Resolve the option and track completion nudges.
# ---------------------------------------------------------------------------

if ($loop -notmatch 'const completionSignalRequired = options\.completionSignalRequired') {
    $needle = @'
  const maxAlignmentNudges = options.taskAlignment?.maxNudges ?? DEFAULT_MAX_ALIGNMENT_NUDGES;
'@

    $replacement = @'
  const maxAlignmentNudges = options.taskAlignment?.maxNudges ?? DEFAULT_MAX_ALIGNMENT_NUDGES;
  const completionSignalRequired = options.completionSignalRequired ?? false;
'@

    $loop = Replace-Once $loop $needle $replacement "completionSignalRequired runtime option"
}

if ($loop -notmatch 'let completionNudges = 0;') {
    $needle = @'
  let alignmentNudges = 0;
'@

    $replacement = @'
  let alignmentNudges = 0;
  let completionNudges = 0;
'@

    $loop = Replace-Once $loop $needle $replacement "completion nudge counter"
}

# ---------------------------------------------------------------------------
# 3. Add a deterministic gate before the existing final-answer break.
# ---------------------------------------------------------------------------

if ($loop -notmatch 'TASK COMPLETION CHECK:') {
    $needle = @'
      answer = content;
      stopReason = 'final-answer';
      break;
'@

    $replacement = @'
      if (completionSignalRequired) {
        const hasCompletionSignal = /^\s*TASK_(?:COMPLETE|BLOCKED):/i.test(content);

        if (!hasCompletionSignal) {
          if (completionNudges < 3) {
            completionNudges += 1;
            messages.push({
              role: 'user',
              content: [
                'TASK COMPLETION CHECK:',
                `The original user request is: ${JSON.stringify(currentGoal)}`,
                '',
                'Your previous response did not declare verified completion or a genuine blocker.',
                'A progress summary is not completion.',
                'Re-read the original request and all tool results.',
                'If actionable work remains and tools are available, continue using tools now.',
                'Do not ask whether to continue.',
                '',
                'Only when every requested executable outcome has been performed and verified,',
                'return a final response beginning exactly with TASK_COMPLETE:.',
                '',
                'If a genuine tool, permission, infrastructure, or external dependency prevents',
                'further progress, return a final response beginning exactly with TASK_BLOCKED:.',
              ].join('\n'),
            });
            continue;
          }

          answer = content;
          stopReason = 'no-progress';
          break;
        }
      }

      answer = content;
      stopReason = 'final-answer';
      break;
'@

    $loop = Replace-Once $loop $needle $replacement "no-tool final-answer completion gate"
}

Set-Content $agentLoopPath $loop -Encoding utf8

# ---------------------------------------------------------------------------
# 4. Make the hard-coded CODING_PROMPT use the same completion protocol.
#    The API currently uses CODING_PROMPT for role=coding.
# ---------------------------------------------------------------------------

$route = Get-Content $routePath -Raw

if ($route -notmatch 'TASK_COMPLETE: only when every requested executable outcome') {
    $needle = @'
8. When finished, give a short answer citing only files, paths, line numbers, commands, and results actually observed during this run.`;
'@

    $replacement = @'
8. When finished, give a short answer citing only files, paths, line numbers, commands, and results actually observed during this run.

Completion protocol:
- Maintain the original user goal for the entire run.
- A plan, directory listing, file discovery, partial inspection, progress summary, or one successful tool call is not completion when more requested work remains.
- Do not say "Let me know if you'd like me to continue", "Would you like me to proceed?", or similar language when the original request already requires the remaining work.
- If actionable work remains and tools are available, continue using tools.
- Recover from correctable tool errors using the error message instead of stopping.
- For multi-step tasks, maintain an internal pending/complete/blocked checklist and compare it with the original request before finalizing.
- Emit TASK_COMPLETE: only when every requested executable outcome has been performed and verified.
- Emit TASK_BLOCKED: only when a genuine tool, permission, infrastructure, missing-capability, or external dependency prevents further progress.
- Never emit TASK_COMPLETE: for ordinary progress narration.`;
'@

    $route = Replace-Once $route $needle $replacement "CODING_PROMPT completion protocol"
}

# Enable the deterministic gate only for the coding role.
if ($route -notmatch 'completionSignalRequired:') {
    $needle = @'
        maxTurns: Math.min(body.maxTurns ?? DEFAULT_AGENT_TURNS, deps.config.limits.maxAgentTurns),
'@

    $replacement = @'
        maxTurns: Math.min(body.maxTurns ?? DEFAULT_AGENT_TURNS, deps.config.limits.maxAgentTurns),
        completionSignalRequired: (body.role ?? 'coding') === 'coding',
'@

    $route = Replace-Once $route $needle $replacement "coding-role completion gate enablement"
}

Set-Content $routePath $route -Encoding utf8

Write-Host ""
Write-Host "Completion gate applied."
Write-Host ""
Write-Host "Now inspect the diff:"
Write-Host "  git diff -- packages/agent-core/src/agent-loop.ts `"$($routePath.Substring($RepoRoot.Length + 1).Replace('\','/'))`""
Write-Host ""
Write-Host "Then run your targeted tests/typecheck before restarting the server."
