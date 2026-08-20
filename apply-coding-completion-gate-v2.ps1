param(
    [string]$RepoRoot = "C:\Users\Kyleh\DacaiLocalAgent"
)

$ErrorActionPreference = "Stop"
Set-Location $RepoRoot

$agentLoopPath = Join-Path $RepoRoot "packages\agent-core\src\agent-loop.ts"

$routeMatch = Get-ChildItem (Join-Path $RepoRoot "apps\server\src") -Recurse -Filter *.ts |
    Select-String -SimpleMatch "/api/agent/stream" |
    Select-Object -First 1

if (-not (Test-Path $agentLoopPath)) {
    throw "Could not find $agentLoopPath"
}
if (-not $routeMatch) {
    throw "Could not locate the server route containing /api/agent/stream"
}

$routePath = $routeMatch.Path
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"

Write-Host "Agent loop: $agentLoopPath"
Write-Host "Agent route: $routePath"

Copy-Item $agentLoopPath "$agentLoopPath.bak-completion-$stamp" -Force
Copy-Item $routePath "$routePath.bak-completion-$stamp" -Force

function Insert-Lines {
    param(
        [System.Collections.Generic.List[string]]$Lines,
        [int]$Index,
        [string[]]$NewLines
    )

    for ($j = $NewLines.Count - 1; $j -ge 0; $j--) {
        $Lines.Insert($Index, $NewLines[$j])
    }
}

# ============================================================================
# packages/agent-core/src/agent-loop.ts
# ============================================================================

$loop = [System.Collections.Generic.List[string]](Get-Content $agentLoopPath)

# 1. Add option: completionSignalRequired?: boolean;
if (-not ($loop -match 'completionSignalRequired\?:\s*boolean;')) {
    $idx = $null
    for ($i = 0; $i -lt $loop.Count; $i++) {
        if ($loop[$i] -match '^\s*evidenceRequirement\?:\s*\{') {
            $idx = $i
            break
        }
    }
    if ($null -eq $idx) {
        throw "Could not find evidenceRequirement?: { in agent-loop.ts"
    }

    $indent = [regex]::Match($loop[$idx], '^\s*').Value
    Insert-Lines $loop $idx @(
        "$indent/**",
        "$indent * Autonomous execution roles can require an explicit completion marker.",
        "$indent * This prevents progress narration from being accepted as task completion.",
        "$indent */",
        "${indent}completionSignalRequired?: boolean;",
        ""
    )
    Write-Host "Added AgentLoopOptions.completionSignalRequired"
} else {
    Write-Host "AgentLoopOptions.completionSignalRequired already present"
}

# 2. Resolve runtime option.
if (-not ($loop -match 'const completionSignalRequired = options\.completionSignalRequired')) {
    $idx = $null
    for ($i = 0; $i -lt $loop.Count; $i++) {
        if ($loop[$i] -match 'const maxAlignmentNudges = options\.taskAlignment\?\.maxNudges') {
            $idx = $i + 1
            break
        }
    }
    if ($null -eq $idx) {
        throw "Could not find maxAlignmentNudges initialization in agent-loop.ts"
    }

    Insert-Lines $loop $idx @(
        "  const completionSignalRequired = options.completionSignalRequired ?? false;"
    )
    Write-Host "Added completionSignalRequired runtime option"
} else {
    Write-Host "completionSignalRequired runtime option already present"
}

# 3. Track completion nudges.
if (-not ($loop -match 'let completionNudges = 0;')) {
    $idx = $null
    for ($i = 0; $i -lt $loop.Count; $i++) {
        if ($loop[$i].Trim() -eq 'let alignmentNudges = 0;') {
            $idx = $i + 1
            break
        }
    }
    if ($null -eq $idx) {
        throw "Could not find alignmentNudges counter in agent-loop.ts"
    }

    Insert-Lines $loop $idx @(
        "  let completionNudges = 0;"
    )
    Write-Host "Added completionNudges counter"
} else {
    Write-Host "completionNudges counter already present"
}

# 4. Insert completion gate immediately before the no-tool final-answer path.
if (-not ($loop -match 'TASK COMPLETION CHECK:')) {
    $idx = $null

    for ($i = 0; $i -lt ($loop.Count - 2); $i++) {
        if (
            $loop[$i].Trim() -eq 'answer = content;' -and
            $loop[$i + 1].Trim() -eq "stopReason = 'final-answer';" -and
            $loop[$i + 2].Trim() -eq 'break;'
        ) {
            $idx = $i
            break
        }
    }

    if ($null -eq $idx) {
        throw "Could not find the final-answer block in agent-loop.ts"
    }

    Insert-Lines $loop $idx @(
        "      if (completionSignalRequired) {",
        "        const hasCompletionSignal = /^\s*TASK_(?:COMPLETE|BLOCKED):/i.test(content);",
        "",
        "        if (!hasCompletionSignal) {",
        "          if (completionNudges < 3) {",
        "            completionNudges += 1;",
        "            messages.push({",
        "              role: 'user',",
        "              content: [",
        "                'TASK COMPLETION CHECK:',",
        "                ``The original user request is: `${JSON.stringify(currentGoal)}``,",
        "                '',",
        "                'Your previous response did not declare verified completion or a genuine blocker.',",
        "                'A progress summary is not completion.',",
        "                'Re-read the original request and all tool results.',",
        "                'If actionable work remains and tools are available, continue using tools now.',",
        "                'Do not ask whether to continue.',",
        "                '',",
        "                'Only when every requested executable outcome has been performed and verified,',",
        "                'return a final response beginning exactly with TASK_COMPLETE:.',",
        "                '',",
        "                'If a genuine tool, permission, infrastructure, or external dependency prevents',",
        "                'further progress, return a final response beginning exactly with TASK_BLOCKED:.',",
        "              ].join('\n'),",
        "            });",
        "            continue;",
        "          }",
        "",
        "          answer = content;",
        "          stopReason = 'no-progress';",
        "          break;",
        "        }",
        "      }",
        ""
    )
    Write-Host "Added no-tool completion gate"
} else {
    Write-Host "Completion gate already present"
}

Set-Content $agentLoopPath $loop -Encoding utf8

# ============================================================================
# apps/server/src/routes/agent.ts
# ============================================================================

$route = [System.Collections.Generic.List[string]](Get-Content $routePath)

# 5. Extend the actual CODING_PROMPT used by role=coding.
if (-not ($route -match 'Emit TASK_COMPLETE: only when every requested executable outcome')) {
    $codingStart = $null
    $codingEnd = $null

    for ($i = 0; $i -lt $route.Count; $i++) {
        if ($route[$i] -match '^const CODING_PROMPT = `') {
            $codingStart = $i
            break
        }
    }
    if ($null -eq $codingStart) {
        throw "Could not find CODING_PROMPT in agent route"
    }

    for ($i = $codingStart + 1; $i -lt $route.Count; $i++) {
        if ($route[$i] -match '^const ADVERSARIAL_TWIN_PROMPT = `') {
            $codingEnd = $i
            break
        }
    }
    if ($null -eq $codingEnd) {
        throw "Could not find end of CODING_PROMPT in agent route"
    }

    $closingLine = $null
    for ($i = $codingEnd - 1; $i -gt $codingStart; $i--) {
        if ($route[$i] -match '`;\s*$') {
            $closingLine = $i
            break
        }
    }
    if ($null -eq $closingLine) {
        throw "Could not find CODING_PROMPT closing line"
    }

    # Remove only the final template-literal terminator from the existing line.
    $route[$closingLine] = $route[$closingLine] -replace '`;\s*$', ''

    Insert-Lines $route ($closingLine + 1) @(
        "",
        "Completion protocol:",
        "- Maintain the original user goal for the entire run.",
        "- A plan, directory listing, file discovery, partial inspection, progress summary, or one successful tool call is not completion when more requested work remains.",
        "- Do not ask whether to continue when the original request already requires the remaining work.",
        "- If actionable work remains and tools are available, continue using tools.",
        "- Recover from correctable tool errors using the returned error instead of stopping.",
        "- For multi-step tasks, maintain an internal pending/complete/blocked checklist and compare it with the original request before finalizing.",
        "- Emit TASK_COMPLETE: only when every requested executable outcome has been performed and verified.",
        "- Emit TASK_BLOCKED: only when a genuine tool, permission, infrastructure, missing-capability, or external dependency prevents further progress.",
        '- Never emit TASK_COMPLETE: for ordinary progress narration.`;'
    )
    Write-Host "Extended CODING_PROMPT with completion protocol"
} else {
    Write-Host "CODING_PROMPT completion protocol already present"
}

# 6. Enable the deterministic completion gate for role=coding.
if (-not ($route -match 'completionSignalRequired:\s*\(body\.role')) {
    $idx = $null

    for ($i = 0; $i -lt $route.Count; $i++) {
        if ($route[$i] -match '^\s*maxTurns:\s*Math\.min\(body\.maxTurns') {
            $idx = $i + 1
            break
        }
    }

    if ($null -eq $idx) {
        throw "Could not find maxTurns entry in runAgentLoop call"
    }

    Insert-Lines $route $idx @(
        "        completionSignalRequired: (body.role ?? 'coding') === 'coding',"
    )
    Write-Host "Enabled completion gate for coding role"
} else {
    Write-Host "Coding-role completion gate already enabled"
}

Set-Content $routePath $route -Encoding utf8

Write-Host ""
Write-Host "PATCH APPLIED"
Write-Host "Backups:"
Write-Host "  $agentLoopPath.bak-completion-$stamp"
Write-Host "  $routePath.bak-completion-$stamp"
Write-Host ""
Write-Host "Inspect:"
Write-Host "  git diff -- packages/agent-core/src/agent-loop.ts apps/server/src/routes/agent.ts"
Write-Host ""
Write-Host "Then run:"
Write-Host "  pnpm -r typecheck"
