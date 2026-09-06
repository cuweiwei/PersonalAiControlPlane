param(
  [string]$Origin = "https://gnest.taila77e5f.ts.net",
  [string]$DataDirectory = "$env:LOCALAPPDATA\.personal-ai-worker",
  [string]$WorkerExecutable = "",
  [string]$Repository = "",
  [string]$SourceRef = "",
  [string]$NodeVersion = "22.19.0",
  [string]$RefreshSource = "",
  [string]$LogDirectory = ""
)

$ErrorActionPreference = "Stop"
$taskName = "Personal AI Worker"

function Fail([string]$Message) { throw "install-worker: $Message" }
function Assert-SafeValue([string]$Name, [string]$Value) {
  if ($Value.Contains('"') -or $Value.Contains("`r") -or $Value.Contains("`n")) { Fail "$Name must not contain quotes or newlines" }
}
function Test-WorkerSource([string]$Root) {
  return (Test-Path -LiteralPath (Join-Path $Root "package.json") -PathType Leaf) -and
    (Test-Path -LiteralPath (Join-Path $Root "package-lock.json") -PathType Leaf) -and
    (Test-Path -LiteralPath (Join-Path $Root "apps\worker\src\cli.ts") -PathType Leaf) -and
    (Test-Path -LiteralPath (Join-Path $Root "packaging\windows\install-worker.ps1") -PathType Leaf)
}
function Test-NodeVersion([string]$NodePath) {
  if (!(Test-Path -LiteralPath $NodePath -PathType Leaf)) { return $false }
  try {
    $versionText = (& $NodePath -p "process.versions.node" 2>$null).Trim()
    if ($LASTEXITCODE -ne 0) { return $false }
    return ([version]$versionText -ge [version]"22.19.0")
  } catch { return $false }
}
function Get-Architecture() {
  $value = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
  switch ($value.ToUpperInvariant()) {
    "AMD64" { return "x64" }
    "ARM64" { return "arm64" }
    default { Fail "unsupported Windows architecture: $value" }
  }
}
function Download([string]$Url, [string]$Destination) {
  Write-Output "Downloading $Url"
  Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $Destination
}
function CmdLiteral([string]$Value) { return $Value.Replace("%", "%%") }

if ([string]::IsNullOrWhiteSpace($Repository)) { $Repository = if ($env:PAI_WORKER_REPOSITORY) { $env:PAI_WORKER_REPOSITORY } else { "https://github.com/cuweiwei/PersonalAiControlPlane" } }
if ([string]::IsNullOrWhiteSpace($SourceRef)) { $SourceRef = if ($env:PAI_WORKER_REF) { $env:PAI_WORKER_REF } else { "main" } }
if ([string]::IsNullOrWhiteSpace($WorkerExecutable)) { $WorkerExecutable = Join-Path $DataDirectory "bin\pai-worker.cmd" }
if ([string]::IsNullOrWhiteSpace($LogDirectory)) { $LogDirectory = Join-Path $DataDirectory "logs" }
$refresh = if ([string]::IsNullOrWhiteSpace($RefreshSource)) { $env:PAI_WORKER_REFRESH_SOURCE -ne "false" } else { $RefreshSource -eq "true" }
$omlxEnabled = if ($env:PAI_OMLX_ENABLED) { $env:PAI_OMLX_ENABLED } else { "true" }
$omlxApiKeyFile = if ($env:PAI_OMLX_API_KEY_FILE) { $env:PAI_OMLX_API_KEY_FILE } else { Join-Path $env:USERPROFILE ".omlx\settings.json" }
$lmstudioEnabled = if ($env:PAI_LMSTUDIO_ENABLED) { $env:PAI_LMSTUDIO_ENABLED } else { "true" }
$ollamaEnabled = if ($env:PAI_OLLAMA_ENABLED) { $env:PAI_OLLAMA_ENABLED } else { "true" }

foreach ($entry in @(
  @{ Name = "Origin"; Value = $Origin },
  @{ Name = "DataDirectory"; Value = $DataDirectory },
  @{ Name = "WorkerExecutable"; Value = $WorkerExecutable },
  @{ Name = "Repository"; Value = $Repository },
  @{ Name = "SourceRef"; Value = $SourceRef },
  @{ Name = "NodeVersion"; Value = $NodeVersion },
  @{ Name = "LogDirectory"; Value = $LogDirectory },
  @{ Name = "OmlxApiKeyFile"; Value = $omlxApiKeyFile }
)) { Assert-SafeValue $entry.Name $entry.Value }
if ($omlxEnabled -notin @("true", "false")) { Fail "PAI_OMLX_ENABLED must be true or false" }
if ($lmstudioEnabled -notin @("true", "false")) { Fail "PAI_LMSTUDIO_ENABLED must be true or false" }
if ($ollamaEnabled -notin @("true", "false")) { Fail "PAI_OLLAMA_ENABLED must be true or false" }
if (!(Test-Path -LiteralPath $DataDirectory -PathType Container)) { New-Item -ItemType Directory -Force -Path $DataDirectory | Out-Null }
if (!(Test-Path -LiteralPath $LogDirectory -PathType Container)) { New-Item -ItemType Directory -Force -Path $LogDirectory | Out-Null }

$task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($task) {
  Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 1
}

$tempDirectory = Join-Path ([IO.Path]::GetTempPath()) ("pai-worker-install-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $tempDirectory | Out-Null
try {
  $sourceCache = Join-Path $DataDirectory "source"
  if (!(Test-WorkerSource $sourceCache) -or $refresh) {
    $sourceArchive = Join-Path $tempDirectory "source.zip"
    $sourceExtract = Join-Path $tempDirectory "source"
    Download "$($Repository.TrimEnd('/'))/archive/$SourceRef.zip" $sourceArchive
    Expand-Archive -LiteralPath $sourceArchive -DestinationPath $sourceExtract -Force
    $archiveRoot = Get-ChildItem -LiteralPath $sourceExtract -Directory | Select-Object -First 1
    if (!$archiveRoot -or !(Test-WorkerSource $archiveRoot.FullName)) { Fail "downloaded source does not contain a Worker checkout" }
    if (Test-Path -LiteralPath $sourceCache) { Remove-Item -LiteralPath $sourceCache -Recurse -Force }
    Move-Item -LiteralPath $archiveRoot.FullName -Destination $sourceCache
  }
  if (!(Test-WorkerSource $sourceCache)) { Fail "Worker source is unavailable at $sourceCache" }

  $nodeBinary = $null
  $systemNode = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($systemNode -and (Test-NodeVersion $systemNode.Source) -and (Test-Path -LiteralPath (Join-Path (Split-Path $systemNode.Source) "npm.cmd") -PathType Leaf)) {
    $nodeBinary = $systemNode.Source
  }
  $nodeRoot = Join-Path $DataDirectory "node-v$NodeVersion"
  if (!$nodeBinary) {
    $nodeArchitecture = Get-Architecture
    $nodeArchiveName = "node-v$NodeVersion-win-$nodeArchitecture.zip"
    $nodeBaseUrl = "https://nodejs.org/dist/v$NodeVersion"
    $nodeArchive = Join-Path $tempDirectory $nodeArchiveName
    $nodeChecksums = Join-Path $tempDirectory "SHASUMS256.txt"
    Download "$nodeBaseUrl/$nodeArchiveName" $nodeArchive
    Download "$nodeBaseUrl/SHASUMS256.txt" $nodeChecksums
    $checksumLine = Select-String -LiteralPath $nodeChecksums -Pattern ([regex]::Escape($nodeArchiveName) + "$") | Select-Object -First 1
    if (!$checksumLine) { Fail "Node.js checksum is missing for $nodeArchiveName" }
    $expectedChecksum = ($checksumLine.Line -split "\s+")[0].ToLowerInvariant()
    $actualChecksum = (Get-FileHash -LiteralPath $nodeArchive -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($expectedChecksum -ne $actualChecksum) { Fail "Node.js checksum mismatch for $nodeArchiveName" }
    $nodeExtract = Join-Path $tempDirectory "node"
    Expand-Archive -LiteralPath $nodeArchive -DestinationPath $nodeExtract -Force
    $extractedNode = Join-Path $nodeExtract ("node-v$NodeVersion-win-$nodeArchitecture")
    if (!(Test-Path -LiteralPath (Join-Path $extractedNode "node.exe") -PathType Leaf)) { Fail "downloaded Node.js archive is incomplete" }
    if (Test-Path -LiteralPath $nodeRoot) { Remove-Item -LiteralPath $nodeRoot -Recurse -Force }
    Move-Item -LiteralPath $extractedNode -Destination $nodeRoot
    $nodeBinary = Join-Path $nodeRoot "node.exe"
  }
  if (!(Test-NodeVersion $nodeBinary)) { Fail "Node.js $nodeBinary is older than the required 22.19.0" }
  $npmBinary = Join-Path (Split-Path $nodeBinary) "npm.cmd"
  if (!(Test-Path -LiteralPath $npmBinary -PathType Leaf)) { Fail "npm was not found beside Node.js" }

  Write-Output "Installing Worker dependencies"
  & $npmBinary ci --prefix $sourceCache
  if ($LASTEXITCODE -ne 0) { Fail "npm ci failed" }

  $workerDirectory = Split-Path $WorkerExecutable -Parent
  New-Item -ItemType Directory -Force -Path $workerDirectory | Out-Null
  $logPath = Join-Path $LogDirectory "worker.log"
  $launcher = @"
@echo off
setlocal
set "PAI_OMLX_ENABLED=$(CmdLiteral $omlxEnabled)"
set "PAI_OMLX_API_KEY_FILE=$(CmdLiteral $omlxApiKeyFile)"
set "PAI_LMSTUDIO_ENABLED=$(CmdLiteral $lmstudioEnabled)"
set "PAI_OLLAMA_ENABLED=$(CmdLiteral $ollamaEnabled)"
set "PAI_WORKER_LOG=$(CmdLiteral $logPath)"
echo [%date% %time%] Worker launcher starting>>"%PAI_WORKER_LOG%"
"$(CmdLiteral $nodeBinary)" --experimental-strip-types "$(CmdLiteral (Join-Path $sourceCache 'apps\worker\src\cli.ts'))" %* >>"%PAI_WORKER_LOG%" 2>&1
set "workerExit=%ERRORLEVEL%"
echo [%date% %time%] Worker launcher exited with code %workerExit%>>"%PAI_WORKER_LOG%"
exit /b %workerExit%
"@
  [IO.File]::WriteAllText($WorkerExecutable, $launcher, [Text.UTF8Encoding]::new($false))

  $principalUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name
  $arguments = "start --origin `"$Origin`" --data-dir `"$DataDirectory`""
  $commandArguments = '/d /s /c ""' + $WorkerExecutable + '" ' + $arguments + '"'
  $action = New-ScheduledTaskAction -Execute $env:ComSpec -Argument $commandArguments -WorkingDirectory $workerDirectory
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $principalUser
  $principal = New-ScheduledTaskPrincipal -UserId $principalUser -LogonType Interactive -RunLevel Limited
  $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Days 3650) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -Hidden
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
  Start-ScheduledTask -TaskName $taskName
  Start-Sleep -Seconds 3
  $taskInfo = Get-ScheduledTaskInfo -TaskName $taskName
  $taskState = (Get-ScheduledTask -TaskName $taskName).State
  if ($taskState -ne "Running") {
    $logTail = if (Test-Path -LiteralPath $logPath) { (Get-Content -LiteralPath $logPath -Tail 40) -join [Environment]::NewLine } else { "(worker log was not created)" }
    Fail "Scheduled Task is $taskState instead of Running. LastTaskResult=$($taskInfo.LastTaskResult). Log: $logPath`n$logTail"
  }
  Write-Output (ConvertTo-Json @{ task = $taskName; origin = $Origin; dataDirectory = $DataDirectory; executable = $WorkerExecutable; source = $sourceCache; node = $nodeBinary; log = $logPath; runLevel = "Limited" })
  Write-Output "Worker installed and started. Existing approved identities do not create a new pending enrollment."
} finally {
  if (Test-Path -LiteralPath $tempDirectory) { Remove-Item -LiteralPath $tempDirectory -Recurse -Force -ErrorAction SilentlyContinue }
}
