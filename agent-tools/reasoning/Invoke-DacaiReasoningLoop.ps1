param(

    [Parameter(Mandatory=$true)]
    [ValidateSet(
        "Start",
        "Observe",
        "Hypothesis",
        "Plan",
        "ToolCall",
        "Verify",
        "Complete",
        "Block",
        "Fail",
        "Show"
    )]
    [string]$Action,

    [string]$RunId,

    [string]$Goal,

    [string]$Text,

    [ValidateSet("low","medium","high")]
    [string]$Confidence = "medium",

    [string]$Tool,

    [string]$Target,

    [string]$Mode = "Discovery",

    [string]$HostName,

    [string]$User,

    [string]$Check = "System",

    [ValidateSet("passed","failed","unknown")]
    [string]$Result = "unknown"
)

$ErrorActionPreference = "Stop"

$ReasoningRoot = $PSScriptRoot
$Root          = Split-Path $ReasoningRoot -Parent
$Runs          = Join-Path $ReasoningRoot "runs"
$Dispatcher    = Join-Path $Root "tools\Invoke-DacaiTool.ps1"

New-Item -ItemType Directory -Force $Runs | Out-Null


function Get-RunPath {

    param([string]$Id)

    if (-not $Id) {
        throw "RunId is required for this action."
    }

    return Join-Path $Runs "$Id.json"
}


function Load-Run {

    param([string]$Id)

    $path = Get-RunPath $Id

    if (-not (Test-Path $path)) {
        throw "Reasoning run '$Id' does not exist."
    }

    return Get-Content $path -Raw | ConvertFrom-Json
}


function Save-Run {

    param(
        $State,
        [string]$Id
    )

    $path = Get-RunPath $Id

    $State.updatedAt = (Get-Date).ToString("o")

    $State |
        ConvertTo-Json -Depth 30 |
        Set-Content -Encoding UTF8 $path
}


function Add-History {

    param(
        $State,
        [string]$Type,
        [string]$Content
    )

    $entry = [pscustomobject]@{
        timestamp = (Get-Date).ToString("o")
        type      = $Type
        content   = $Content
    }

    $State.history = @($State.history) + $entry
}


switch ($Action) {

    # --------------------------------------------------------
    # START
    # --------------------------------------------------------

    "Start" {

        if (-not $Goal) {
            throw "Goal is required when starting a reasoning run."
        }

        $RunId = [guid]::NewGuid().ToString()

        $state = [ordered]@{

            runId       = $RunId

            goal        = $Goal

            status      = "active"

            phase       = "observe"

            createdAt   = (Get-Date).ToString("o")

            updatedAt   = (Get-Date).ToString("o")

            observations = @()

            hypotheses   = @()

            plan         = @()

            actions      = @()

            verification = @()

            blockers     = @()

            history      = @()
        }

        Add-History `
            -State $state `
            -Type "goal" `
            -Content $Goal

        Save-Run $state $RunId

        Write-Host ""
        Write-Host "DACAIS reasoning run created." -ForegroundColor Green
        Write-Host "RunId: $RunId" -ForegroundColor Cyan
        Write-Host "Phase: observe"
        Write-Host ""

        $state | ConvertTo-Json -Depth 20
    }


    # --------------------------------------------------------
    # OBSERVATION
    # --------------------------------------------------------

    "Observe" {

        if (-not $Text) {
            throw "Text is required."
        }

        $state = Load-Run $RunId

        $entry = [pscustomobject]@{
            timestamp = (Get-Date).ToString("o")
            observation = $Text
        }

        $state.observations =
            @($state.observations) + $entry

        $state.phase = "hypothesize"

        Add-History $state "observation" $Text

        Save-Run $state $RunId

        $state | ConvertTo-Json -Depth 20
    }


    # --------------------------------------------------------
    # HYPOTHESIS
    # --------------------------------------------------------

    "Hypothesis" {

        if (-not $Text) {
            throw "Text is required."
        }

        $state = Load-Run $RunId

        $entry = [pscustomobject]@{
            timestamp  = (Get-Date).ToString("o")
            hypothesis = $Text
            confidence = $Confidence
            status     = "untested"
        }

        $state.hypotheses =
            @($state.hypotheses) + $entry

        $state.phase = "plan"

        Add-History `
            $state `
            "hypothesis" `
            "$Text [confidence=$Confidence]"

        Save-Run $state $RunId

        $state | ConvertTo-Json -Depth 20
    }


    # --------------------------------------------------------
    # PLAN
    # --------------------------------------------------------

    "Plan" {

        if (-not $Text) {
            throw "Text is required."
        }

        $state = Load-Run $RunId

        $entry = [pscustomobject]@{
            timestamp = (Get-Date).ToString("o")
            step      = $Text
            status    = "pending"
        }

        $state.plan =
            @($state.plan) + $entry

        $state.phase = "act"

        Add-History $state "plan" $Text

        Save-Run $state $RunId

        $state | ConvertTo-Json -Depth 20
    }


    # --------------------------------------------------------
    # TOOL EXECUTION
    # --------------------------------------------------------

    "ToolCall" {

        if (-not $Tool) {
            throw "Tool is required."
        }

        if (-not (Test-Path $Dispatcher)) {
            throw "Tool dispatcher not found: $Dispatcher"
        }

        $state = Load-Run $RunId

        $arguments = @{
            Tool = $Tool
        }

        if ($Target) {
            $arguments.Target = $Target
        }

        if ($Mode) {
            $arguments.Mode = $Mode
        }

        if ($HostName) {
            $arguments.HostName = $HostName
        }

        if ($User) {
            $arguments.User = $User
        }

        if ($Check) {
            $arguments.Check = $Check
        }

        $started = (Get-Date).ToString("o")

        try {

            $output = & $Dispatcher @arguments 2>&1 |
                Out-String

            $toolStatus = "success"
        }
        catch {

            $output = $_ | Out-String
            $toolStatus = "failed"
        }

        $actionRecord = [pscustomobject]@{

            timestamp = $started

            tool      = $Tool

            arguments = $arguments

            status    = $toolStatus

            output    = $output
        }

        $state.actions =
            @($state.actions) + $actionRecord

        if ($toolStatus -eq "success") {

            $state.phase = "verify"

        } else {

            $state.phase = "replan"
        }

        Add-History `
            $state `
            "tool" `
            "$Tool => $toolStatus"

        Save-Run $state $RunId

        Write-Host ""
        Write-Host "TOOL: $Tool" -ForegroundColor Cyan
        Write-Host "STATUS: $toolStatus"
        Write-Host ""
        Write-Output $output
        Write-Host ""
        Write-Host "RUN ID: $RunId" -ForegroundColor Yellow
        Write-Host "NEXT PHASE: $($state.phase)" -ForegroundColor Yellow
    }


    # --------------------------------------------------------
    # VERIFY
    # --------------------------------------------------------

    "Verify" {

        if (-not $Text) {
            throw "Verification description is required."
        }

        $state = Load-Run $RunId

        $entry = [pscustomobject]@{

            timestamp = (Get-Date).ToString("o")

            test       = $Text

            result     = $Result

            confidence = $Confidence
        }

        $state.verification =
            @($state.verification) + $entry

        if ($Result -eq "passed") {

            $state.phase = "complete"

        } elseif ($Result -eq "failed") {

            $state.phase = "replan"

        } else {

            $state.phase = "observe"
        }

        Add-History `
            $state `
            "verification" `
            "$Text => $Result"

        Save-Run $state $RunId

        $state | ConvertTo-Json -Depth 20
    }


    # --------------------------------------------------------
    # COMPLETE
    # --------------------------------------------------------

    "Complete" {

        $state = Load-Run $RunId

        $passed =
            @($state.verification) |
            Where-Object result -eq "passed"

        if (-not $passed) {

            throw @"
Cannot mark this run complete.

The original objective has not been independently verified.

Run a verification step first.
"@
        }

        $state.status = "completed"
        $state.phase  = "complete"

        Add-History `
            $state `
            "completion" `
            "Objective independently verified."

        Save-Run $state $RunId

        Write-Host ""
        Write-Host "OBJECTIVE VERIFIED" -ForegroundColor Green
        Write-Host "RunId: $RunId"
        Write-Host ""

        $state | ConvertTo-Json -Depth 20
    }


    # --------------------------------------------------------
    # BLOCKED
    # --------------------------------------------------------

    "Block" {

        if (-not $Text) {
            throw "Blocker description is required."
        }

        $state = Load-Run $RunId

        $blocker = [pscustomobject]@{

            timestamp = (Get-Date).ToString("o")

            blocker = $Text
        }

        $state.blockers =
            @($state.blockers) + $blocker

        $state.status = "blocked"

        Add-History $state "blocker" $Text

        Save-Run $state $RunId

        $state | ConvertTo-Json -Depth 20
    }


    # --------------------------------------------------------
    # FAIL
    # --------------------------------------------------------

    "Fail" {

        $state = Load-Run $RunId

        $state.status = "failed"

        if ($Text) {
            Add-History $state "failure" $Text
        }

        Save-Run $state $RunId

        $state | ConvertTo-Json -Depth 20
    }


    # --------------------------------------------------------
    # SHOW STATE
    # --------------------------------------------------------

    "Show" {

        $state = Load-Run $RunId

        $state | ConvertTo-Json -Depth 30
    }
}
