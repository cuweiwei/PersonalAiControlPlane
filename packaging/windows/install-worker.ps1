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
function PowerShellLiteral([string]$Value) { return "'" + $Value.Replace("'", "''") + "'" }
function Get-WorkerProcesses([string]$Directory, [string]$Executable, [string]$SourceRoot, [string]$LauncherDirectory) {
  $cliPath = (Join-Path $SourceRoot "apps\worker\src\cli.ts").ToLowerInvariant()
  $dataPath = $Directory.ToLowerInvariant()
  $workerCommand = $Executable.ToLowerInvariant()
  $oldVbs = (Join-Path $LauncherDirectory "pai-worker-hidden.vbs").ToLowerInvariant()
  $scheduledScript = (Join-Path $LauncherDirectory "pai-worker-scheduled.ps1").ToLowerInvariant()
  return @(
    Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object {
      $command = if ($_.CommandLine) { $_.CommandLine.ToLowerInvariant() } else { "" }
      if (!$command) { return $false }
      switch ($_.Name.ToLowerInvariant()) {
        "node.exe" { return $command.Contains($cliPath) -and $command.Contains("--data-dir") -and $command.Contains($dataPath) }
        "cmd.exe" { return $command.Contains($workerCommand) -and $command.Contains("--data-dir") -and $command.Contains($dataPath) }
        "wscript.exe" { return $command.Contains($oldVbs) }
        "cscript.exe" { return $command.Contains($oldVbs) }
        "powershell.exe" { return $command.Contains($scheduledScript) }
        "pwsh.exe" { return $command.Contains($scheduledScript) }
        default { return $false }
      }
    }
  )
}
function Get-ActiveWorkerAttemptCount([string]$NodePath, [string]$Directory) {
  $journal = Join-Path $Directory "worker.db"
  if (!(Test-Path -LiteralPath $journal -PathType Leaf)) { return 0 }
  $probePath = Join-Path ([IO.Path]::GetTempPath()) ("pai-worker-journal-" + [Guid]::NewGuid().ToString("N") + ".cjs")
  $probe = @'
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.argv[2], { readOnly: true });
try {
  const row = db.prepare("SELECT COUNT(*) AS count FROM assignments WHERE status IN ('ACCEPTED','RUNNING')").get();
  console.log(row.count);
} finally {
  db.close();
}
'@
  $stdoutPath = "$probePath.out"
  $stderrPath = "$probePath.err"
  [IO.File]::WriteAllText($probePath, $probe, [Text.UTF8Encoding]::new($false))
  try {
    $probeArguments = '"' + $probePath + '" "' + $journal + '"'
    $probeProcess = Start-Process -FilePath $NodePath -ArgumentList $probeArguments -NoNewWindow -Wait -PassThru -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath
    $probeExitCode = $probeProcess.ExitCode
    $output = if (Test-Path -LiteralPath $stdoutPath) { Get-Content -LiteralPath $stdoutPath -Raw } else { "" }
    $diagnostic = if (Test-Path -LiteralPath $stderrPath) { (Get-Content -LiteralPath $stderrPath -Raw).Trim() } else { "" }
  } finally {
    foreach ($path in @($probePath, $stdoutPath, $stderrPath)) {
      if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue }
    }
  }
  if ($probeExitCode -ne 0) { Fail "could not inspect the Worker journal at $journal; no processes were stopped. $diagnostic" }
  $countText = ($output | Out-String).Trim()
  if ($countText -notmatch '^\d+$') { Fail "Worker journal returned an invalid active-attempt count; no processes were stopped" }
  return [int]$countText
}
function Stop-ExistingWorkerSafely([string]$NodePath, [string]$Directory, [string]$Executable, [string]$SourceRoot, [string]$LauncherDirectory) {
  $processes = @(Get-WorkerProcesses $Directory $Executable $SourceRoot $LauncherDirectory)
  $journal = Join-Path $Directory "worker.db"
  if ($processes.Count -gt 0 -and !(Test-Path -LiteralPath $journal -PathType Leaf)) {
    Fail "a Worker process is running but its local journal is missing; refusing to stop it without checking active work"
  }
  $activeAttempts = Get-ActiveWorkerAttemptCount $NodePath $Directory
  if ($activeAttempts -gt 0) {
    Fail "Worker journal contains $activeAttempts ACCEPTED/RUNNING attempt(s); let them finish before reinstalling. No process was stopped"
  }

  $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  if ($task) {
    Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 500
  }
  $activeAttempts = Get-ActiveWorkerAttemptCount $NodePath $Directory
  if ($activeAttempts -gt 0) {
    Fail "Worker received $activeAttempts ACCEPTED/RUNNING attempt(s) while stopping; the scheduled task was stopped, but its Worker process was left intact. Let the work finish and retry"
  }

  $processes = @(Get-WorkerProcesses $Directory $Executable $SourceRoot $LauncherDirectory)
  if ($processes.Count -eq 0) { return }
  $ids = @($processes | ForEach-Object { [int]$_.ProcessId })
  $roots = @($processes | Where-Object { $ids -notcontains [int]$_.ParentProcessId })
  if ($roots.Count -eq 0) { $roots = $processes }
  $taskkill = Join-Path $env:WINDIR "System32\taskkill.exe"
  foreach ($process in $roots) {
    & $taskkill /PID ([string]$process.ProcessId) /T /F | Out-Null
  }
  for ($attempt = 0; $attempt -lt 20; $attempt++) {
    Start-Sleep -Milliseconds 500
    $remaining = @(Get-WorkerProcesses $Directory $Executable $SourceRoot $LauncherDirectory)
    if ($remaining.Count -eq 0) { return }
  }
  $remainingIds = (@($remaining | ForEach-Object { [string]$_.ProcessId }) -join ", ")
  Fail "could not stop stale Worker process(es) $remainingIds; source files were not replaced"
}

if ([string]::IsNullOrWhiteSpace($Repository)) { $Repository = if ($env:PAI_WORKER_REPOSITORY) { $env:PAI_WORKER_REPOSITORY } else { "https://github.com/cuweiwei/PersonalAiControlPlane" } }
if ([string]::IsNullOrWhiteSpace($SourceRef)) { $SourceRef = if ($env:PAI_WORKER_REF) { $env:PAI_WORKER_REF } else { "main" } }
if ([string]::IsNullOrWhiteSpace($WorkerExecutable)) { $WorkerExecutable = Join-Path $DataDirectory "bin\pai-worker.cmd" }
if ([string]::IsNullOrWhiteSpace($LogDirectory)) { $LogDirectory = Join-Path $DataDirectory "logs" }
$refresh = if ([string]::IsNullOrWhiteSpace($RefreshSource)) { $env:PAI_WORKER_REFRESH_SOURCE -ne "false" } else { $RefreshSource -eq "true" }
$omlxEnabled = if ($env:PAI_OMLX_ENABLED) { $env:PAI_OMLX_ENABLED } else { "true" }
$omlxApiKeyFile = if ($env:PAI_OMLX_API_KEY_FILE) { $env:PAI_OMLX_API_KEY_FILE } else { Join-Path $env:USERPROFILE ".omlx\settings.json" }
$lmstudioEnabled = if ($env:PAI_LMSTUDIO_ENABLED) { $env:PAI_LMSTUDIO_ENABLED } else { "true" }
$ollamaEnabled = if ($env:PAI_OLLAMA_ENABLED) { $env:PAI_OLLAMA_ENABLED } else { "true" }
$cuaEnabled = if ($env:PAI_CUA_ENABLED) { $env:PAI_CUA_ENABLED } else { "true" }
$cuaDriverExecutable = if ($env:PAI_CUA_DRIVER_EXECUTABLE) { $env:PAI_CUA_DRIVER_EXECUTABLE } else { "" }
$cuaDriverSocket = if ($env:PAI_CUA_DRIVER_SOCKET) { $env:PAI_CUA_DRIVER_SOCKET } else { "\\.\pipe\cua-driver" }
$cuaDriverMode = if ($env:PAI_CUA_DRIVER_MODE) { $env:PAI_CUA_DRIVER_MODE } else { "mcp" }
$cuaDriverVersion = if ($env:PAI_CUA_DRIVER_VERSION) { $env:PAI_CUA_DRIVER_VERSION } else { "" }

if ($cuaEnabled -eq "true" -and [string]::IsNullOrWhiteSpace($cuaDriverExecutable)) {
  $cuaCommand = Get-Command cua-driver.exe -CommandType Application -ErrorAction SilentlyContinue
  if (!$cuaCommand) { $cuaCommand = Get-Command cua-driver -CommandType Application -ErrorAction SilentlyContinue }
  if ($cuaCommand) { $cuaDriverExecutable = $cuaCommand.Source }
  else { $cuaDriverExecutable = Join-Path $env:LOCALAPPDATA "Programs\Cua\cua-driver\bin\cua-driver.exe" }
}

foreach ($entry in @(
  @{ Name = "Origin"; Value = $Origin },
  @{ Name = "DataDirectory"; Value = $DataDirectory },
  @{ Name = "WorkerExecutable"; Value = $WorkerExecutable },
  @{ Name = "Repository"; Value = $Repository },
  @{ Name = "SourceRef"; Value = $SourceRef },
  @{ Name = "NodeVersion"; Value = $NodeVersion },
  @{ Name = "LogDirectory"; Value = $LogDirectory },
  @{ Name = "OmlxApiKeyFile"; Value = $omlxApiKeyFile },
  @{ Name = "CuaDriverExecutable"; Value = $cuaDriverExecutable },
  @{ Name = "CuaDriverSocket"; Value = $cuaDriverSocket },
  @{ Name = "CuaDriverVersion"; Value = $cuaDriverVersion }
)) { Assert-SafeValue $entry.Name $entry.Value }
if ($omlxEnabled -notin @("true", "false")) { Fail "PAI_OMLX_ENABLED must be true or false" }
if ($lmstudioEnabled -notin @("true", "false")) { Fail "PAI_LMSTUDIO_ENABLED must be true or false" }
if ($ollamaEnabled -notin @("true", "false")) { Fail "PAI_OLLAMA_ENABLED must be true or false" }
if ($cuaEnabled -notin @("true", "false")) { Fail "PAI_CUA_ENABLED must be true or false" }
if ($cuaDriverMode -notin @("mcp", "cli")) { Fail "PAI_CUA_DRIVER_MODE must be mcp or cli" }
if ($cuaEnabled -eq "true") {
  if ([string]::IsNullOrWhiteSpace($cuaDriverExecutable)) { Fail "PAI_CUA_DRIVER_EXECUTABLE is required when CUA is enabled; set it to the absolute cua-driver.exe path" }
  if (![IO.Path]::IsPathRooted($cuaDriverExecutable)) { Fail "PAI_CUA_DRIVER_EXECUTABLE must be an absolute path when CUA is enabled" }
  if ($cuaDriverVersion -and $cuaDriverVersion -notmatch '^[A-Za-z0-9._-]+$') { Fail "PAI_CUA_DRIVER_VERSION contains unsupported characters" }
  if ($cuaDriverMode -eq "mcp" -and [string]::IsNullOrWhiteSpace($cuaDriverSocket)) { Fail "PAI_CUA_DRIVER_SOCKET is required in MCP mode; configure the local CUA daemon endpoint explicitly" }
  if ($cuaDriverMode -eq "mcp" -and ![IO.Path]::IsPathRooted($cuaDriverSocket) -and !$cuaDriverSocket.StartsWith("\\\\")) { Fail "PAI_CUA_DRIVER_SOCKET must be an absolute path or named pipe in MCP mode" }
  if ($cuaDriverSocket -ne "\\.\pipe\cua-driver") { Fail "the one-click Windows CUA service uses the Cua Driver default named pipe \\.\pipe\cua-driver; custom daemon endpoints must be managed separately" }
}
if (!(Test-Path -LiteralPath $DataDirectory -PathType Container)) { New-Item -ItemType Directory -Force -Path $DataDirectory | Out-Null }
if (!(Test-Path -LiteralPath $LogDirectory -PathType Container)) { New-Item -ItemType Directory -Force -Path $LogDirectory | Out-Null }

$tempDirectory = Join-Path ([IO.Path]::GetTempPath()) ("pai-worker-install-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $tempDirectory | Out-Null
$installSucceeded = $false
$sourceBackupPath = $null
try {
  if ($cuaEnabled -eq "true") {
    if (!(Test-Path -LiteralPath $cuaDriverExecutable -PathType Leaf)) {
      $cuaInstaller = Join-Path $tempDirectory "cua-driver-install.ps1"
      Download "https://cua.ai/driver/install.ps1" $cuaInstaller
      $powershellInstaller = Join-Path $env:WINDIR "System32\WindowsPowerShell\v1.0\powershell.exe"
      if (!(Test-Path -LiteralPath $powershellInstaller -PathType Leaf)) { Fail "Windows PowerShell was not found to install CUA Driver" }
      $previousCuaVersion = $env:CUA_DRIVER_RS_VERSION
      try {
        if ($cuaDriverVersion) { $env:CUA_DRIVER_RS_VERSION = $cuaDriverVersion }
        & $powershellInstaller -NoLogo -NoProfile -ExecutionPolicy Bypass -File $cuaInstaller -NoPathUpdate
        if ($LASTEXITCODE -ne 0) { Fail "CUA Driver installer exited with code $LASTEXITCODE" }
      } finally {
        if ($null -eq $previousCuaVersion) { Remove-Item Env:CUA_DRIVER_RS_VERSION -ErrorAction SilentlyContinue }
        else { $env:CUA_DRIVER_RS_VERSION = $previousCuaVersion }
      }
    }
    if (!(Test-Path -LiteralPath $cuaDriverExecutable -PathType Leaf)) { Fail "CUA Driver installer completed but executable was not found: $cuaDriverExecutable" }
    & $cuaDriverExecutable doctor | Out-Host
    if ($LASTEXITCODE -ne 0) { Fail "CUA Driver doctor failed; resolve the local desktop requirements and retry" }
    & $cuaDriverExecutable autostart enable
    if ($LASTEXITCODE -ne 0) { Fail "CUA Driver could not register its interactive-user autostart task; run the installer from the signed-in desktop session" }
    & $cuaDriverExecutable autostart kick
    if ($LASTEXITCODE -ne 0) { Fail "CUA Driver autostart task could not be started" }
    $driverReady = $false
    for ($attempt = 0; $attempt -lt 20; $attempt++) {
      $driverStatus = (& $cuaDriverExecutable status 2>&1 | Out-String).Trim()
      if ($LASTEXITCODE -eq 0 -and $driverStatus -match "daemon is running") { $driverReady = $true; break }
      Start-Sleep -Seconds 1
    }
    if (!$driverReady) { Fail "CUA Driver daemon did not become ready in the current interactive session: $driverStatus" }
    Write-Output "CUA Driver ready: $cuaDriverExecutable ($cuaDriverSocket)"
  }

  $sourceCache = Join-Path $DataDirectory "source"
  $sourceCandidate = $null
  if (!(Test-WorkerSource $sourceCache) -or $refresh) {
    $sourceArchive = Join-Path $tempDirectory "source.zip"
    $sourceExtract = Join-Path $tempDirectory "source"
    Download "$($Repository.TrimEnd('/'))/archive/$SourceRef.zip" $sourceArchive
    Expand-Archive -LiteralPath $sourceArchive -DestinationPath $sourceExtract -Force
    $archiveRoot = Get-ChildItem -LiteralPath $sourceExtract -Directory | Select-Object -First 1
    if (!$archiveRoot -or !(Test-WorkerSource $archiveRoot.FullName)) { Fail "downloaded source does not contain a Worker checkout" }
    $sourceCandidate = $archiveRoot.FullName
  }
  $sourceForInstall = if ($sourceCandidate) { $sourceCandidate } else { $sourceCache }
  if (!(Test-WorkerSource $sourceForInstall)) { Fail "Worker source is unavailable at $sourceForInstall" }

  $nodeBinary = $null
  $systemNode = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($systemNode -and (Test-NodeVersion $systemNode.Source) -and (Test-Path -LiteralPath (Join-Path (Split-Path $systemNode.Source) "npm.cmd") -PathType Leaf)) {
    $nodeBinary = $systemNode.Source
  }
  $nodeRoot = Join-Path $DataDirectory "node-v$NodeVersion"
  $nodeCandidateRoot = $null
  if (!$nodeBinary) {
    $managedNode = Join-Path $nodeRoot "node.exe"
    if (Test-NodeVersion $managedNode) {
      $nodeBinary = $managedNode
    } else {
      $nodeArchitecture = Get-Architecture
      $nodeArchiveName = "node-v$NodeVersion-win-$nodeArchitecture.zip"
      $nodeBaseUrl = "https://nodejs.org/dist/v$NodeVersion"
      $nodeArchive = Join-Path $tempDirectory $nodeArchiveName
      $nodeChecksums = Join-Path $tempDirectory "SHASUMS256.txt"
      Download "$nodeBaseUrl/$nodeArchiveName" $nodeArchive
      Download "$nodeBaseUrl/SHASUMS256.txt" $nodeChecksums
      $checksumLine = Select-String -LiteralPath $nodeChecksums -Pattern ([regex]::Escape($nodeArchiveName) + "$" ) | Select-Object -First 1
      if (!$checksumLine) { Fail "Node.js checksum is missing for $nodeArchiveName" }
      $expectedChecksum = ($checksumLine.Line -split "\s+")[0].ToLowerInvariant()
      $actualChecksum = (Get-FileHash -LiteralPath $nodeArchive -Algorithm SHA256).Hash.ToLowerInvariant()
      if ($expectedChecksum -ne $actualChecksum) { Fail "Node.js checksum mismatch for $nodeArchiveName" }
      $nodeExtract = Join-Path $tempDirectory "node"
      Expand-Archive -LiteralPath $nodeArchive -DestinationPath $nodeExtract -Force
      $nodeCandidateRoot = Join-Path $nodeExtract ("node-v$NodeVersion-win-$nodeArchitecture")
      if (!(Test-Path -LiteralPath (Join-Path $nodeCandidateRoot "node.exe") -PathType Leaf)) { Fail "downloaded Node.js archive is incomplete" }
      $nodeBinary = Join-Path $nodeCandidateRoot "node.exe"
    }
  }
  if (!(Test-NodeVersion $nodeBinary)) { Fail "Node.js $nodeBinary is older than the required 22.19.0" }
  $npmBinary = Join-Path (Split-Path $nodeBinary) "npm.cmd"
  if (!(Test-Path -LiteralPath $npmBinary -PathType Leaf)) { Fail "npm was not found beside Node.js" }

  $workerDirectory = Split-Path $WorkerExecutable -Parent
  New-Item -ItemType Directory -Force -Path $workerDirectory | Out-Null
  $workerStopped = $false
  if ($sourceCandidate -or !(Test-Path -LiteralPath (Join-Path $sourceForInstall "node_modules") -PathType Container)) {
    if (!$sourceCandidate) {
      Stop-ExistingWorkerSafely $nodeBinary $DataDirectory $WorkerExecutable $sourceCache $workerDirectory
      $workerStopped = $true
    }
    Write-Output "Installing Worker dependencies"
    & $npmBinary ci --prefix $sourceForInstall
    if ($LASTEXITCODE -ne 0) { Fail "npm ci failed" }
  }

  if (!$workerStopped) {
    Stop-ExistingWorkerSafely $nodeBinary $DataDirectory $WorkerExecutable $sourceCache $workerDirectory
    $workerStopped = $true
  }
  if ($nodeCandidateRoot) {
    if (Test-Path -LiteralPath $nodeRoot) { Remove-Item -LiteralPath $nodeRoot -Recurse -Force }
    Move-Item -LiteralPath $nodeCandidateRoot -Destination $nodeRoot
    $nodeBinary = Join-Path $nodeRoot "node.exe"
  }
  if ($sourceCandidate) {
    if (Test-Path -LiteralPath $sourceCache) {
      $sourceBackupPath = Join-Path $DataDirectory ("source.previous-" + [Guid]::NewGuid().ToString("N"))
      Move-Item -LiteralPath $sourceCache -Destination $sourceBackupPath
    }
    try {
      Move-Item -LiteralPath $sourceCandidate -Destination $sourceCache
    } catch {
      if ($sourceBackupPath -and (Test-Path -LiteralPath $sourceBackupPath) -and !(Test-Path -LiteralPath $sourceCache)) {
        Move-Item -LiteralPath $sourceBackupPath -Destination $sourceCache
        $sourceBackupPath = $null
      }
      throw
    }
  }

  $logPath = Join-Path $LogDirectory "worker.log"
  $launcher = @"
@echo off
setlocal
set "PAI_OMLX_ENABLED=$(CmdLiteral $omlxEnabled)"
set "PAI_OMLX_API_KEY_FILE=$(CmdLiteral $omlxApiKeyFile)"
set "PAI_LMSTUDIO_ENABLED=$(CmdLiteral $lmstudioEnabled)"
set "PAI_OLLAMA_ENABLED=$(CmdLiteral $ollamaEnabled)"
set "PAI_CUA_ENABLED=$(CmdLiteral $cuaEnabled)"
set "PAI_CUA_DRIVER_EXECUTABLE=$(CmdLiteral $cuaDriverExecutable)"
set "PAI_CUA_DRIVER_SOCKET=$(CmdLiteral $cuaDriverSocket)"
set "PAI_CUA_DRIVER_MODE=$(CmdLiteral $cuaDriverMode)"
set "PAI_WORKER_LOG=$(CmdLiteral $logPath)"
echo [%date% %time%] Worker launcher starting>>"%PAI_WORKER_LOG%"
"$(CmdLiteral $nodeBinary)" --experimental-strip-types "$(CmdLiteral (Join-Path $sourceCache 'apps\worker\src\cli.ts'))" %* >>"%PAI_WORKER_LOG%" 2>&1
set "workerExit=%ERRORLEVEL%"
echo [%date% %time%] Worker launcher exited with code %workerExit%>>"%PAI_WORKER_LOG%"
exit /b %workerExit%
"@
  [IO.File]::WriteAllText($WorkerExecutable, $launcher, [Text.UTF8Encoding]::new($false))

  $principalUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name
  $scheduledLauncherPath = Join-Path $workerDirectory "pai-worker-scheduled.ps1"
  $scheduledLauncher = @"
`$ErrorActionPreference = 'Stop'
& $(PowerShellLiteral $WorkerExecutable) start --origin $(PowerShellLiteral $Origin) --data-dir $(PowerShellLiteral $DataDirectory)
`$workerExit = `$LASTEXITCODE
exit `$workerExit
"@
  [IO.File]::WriteAllText($scheduledLauncherPath, $scheduledLauncher, [Text.UTF8Encoding]::new($true))
  $powershellExecutable = Join-Path $env:WINDIR "System32\WindowsPowerShell\v1.0\powershell.exe"
  $actionArguments = "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$scheduledLauncherPath`""
  $action = New-ScheduledTaskAction -Execute $powershellExecutable -Argument $actionArguments -WorkingDirectory $workerDirectory
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $principalUser
  $principal = New-ScheduledTaskPrincipal -UserId $principalUser -LogonType Interactive -RunLevel Limited
  $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Days 3650) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -Hidden
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
  Start-ScheduledTask -TaskName $taskName
  for ($attempt = 0; $attempt -lt 30; $attempt++) {
    $taskState = (Get-ScheduledTask -TaskName $taskName).State
    if ($taskState -eq "Running") { break }
    Start-Sleep -Seconds 1
  }
  $taskInfo = Get-ScheduledTaskInfo -TaskName $taskName
  if ($taskState -ne "Running") {
    $logTail = if (Test-Path -LiteralPath $logPath) { (Get-Content -LiteralPath $logPath -Tail 40) -join [Environment]::NewLine } else { "(worker log was not created)" }
    Fail "Scheduled Task is $taskState instead of Running. LastTaskResult=$($taskInfo.LastTaskResult). Log: $logPath`n$logTail"
  }
  $installSucceeded = $true
  if ($sourceBackupPath -and (Test-Path -LiteralPath $sourceBackupPath)) { Remove-Item -LiteralPath $sourceBackupPath -Recurse -Force }
  Write-Output (ConvertTo-Json @{ task = $taskName; origin = $Origin; dataDirectory = $DataDirectory; executable = $WorkerExecutable; backgroundLauncher = $scheduledLauncherPath; source = $sourceCache; node = $nodeBinary; log = $logPath; runLevel = "Limited" })
  Write-Output "Worker installed and started. Existing approved identities do not create a new pending enrollment."
} finally {
  if ($installSucceeded -and $sourceBackupPath -and (Test-Path -LiteralPath $sourceBackupPath)) { Remove-Item -LiteralPath $sourceBackupPath -Recurse -Force -ErrorAction SilentlyContinue }
  if (Test-Path -LiteralPath $tempDirectory) { Remove-Item -LiteralPath $tempDirectory -Recurse -Force -ErrorAction SilentlyContinue }
}
