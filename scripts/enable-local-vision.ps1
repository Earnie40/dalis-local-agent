param(
  [string]$Model = "qwen2.5vl:7b",
  [string]$RepoRoot = "C:\Users\Kyleh\DacaiLocalAgent"
)

$ErrorActionPreference = "Stop"
if (-not (Get-Command ollama -ErrorAction SilentlyContinue)) {
  throw "Ollama is not installed or is not on PATH."
}

$list = ollama list
if ($list -notmatch [regex]::Escape($Model.Split(':')[0])) {
  Write-Host "Pulling local vision model $Model ..."
  ollama pull $Model
  if ($LASTEXITCODE -ne 0) { throw "Ollama could not pull $Model. Choose another installed vision-capable model." }
}

$envPath = Join-Path $RepoRoot ".env"
if (-not (Test-Path $envPath)) { New-Item -ItemType File -Path $envPath -Force | Out-Null }
$text = Get-Content $envPath -Raw
if ($text -match "(?m)^DACAI_VISION_MODEL=") {
  $text = [regex]::Replace($text, "(?m)^DACAI_VISION_MODEL=.*$", "DACAI_VISION_MODEL=$Model")
} else {
  if ($text -and -not $text.EndsWith("`n")) { $text += "`r`n" }
  $text += "DACAI_VISION_MODEL=$Model`r`n"
}
[IO.File]::WriteAllText($envPath, $text, [Text.UTF8Encoding]::new($false))
Write-Host "Configured DACAI_VISION_MODEL=$Model"
Write-Host "Restart pnpm dev before using vision.inspect."
