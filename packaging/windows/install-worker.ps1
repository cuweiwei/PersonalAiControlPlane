param(
  [Parameter(Mandatory=$true)][string]$RepoId,
  [Parameter(Mandatory=$true)][string]$RepoPath,
  [string]$Origin = "https://gnest.taila77e5f.ts.net",
  [string]$WorkerExecutable = "$env:LOCALAPPDATA\Programs\PersonalAiWorker\pai-worker.cmd"
)

$taskName = "Personal AI Worker"
if (!(Test-Path -LiteralPath $WorkerExecutable)) { throw "worker executable does not exist: $WorkerExecutable" }
if (!(Test-Path -LiteralPath $RepoPath -PathType Container)) { throw "repository path does not exist: $RepoPath" }
foreach ($value in @($RepoId, $RepoPath, $Origin, $WorkerExecutable)) {
  if ($value.Contains('"') -or $value.Contains("`r") -or $value.Contains("`n")) { throw "arguments must not contain quotes or newlines" }
}
$arguments = "start --origin `"$Origin`" --repo-id `"$RepoId`" --repo-path `"$RepoPath`""
$action = New-ScheduledTaskAction -Execute $WorkerExecutable -Argument $arguments -WorkingDirectory (Split-Path $WorkerExecutable)
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Days 3650)
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName $taskName
Write-Output (ConvertTo-Json @{ task = $taskName; origin = $Origin; repoId = $RepoId; runLevel = "Limited" })
