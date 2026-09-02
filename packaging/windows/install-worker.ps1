param(
  [string]$Origin = "https://gnest.taila77e5f.ts.net",
  [string]$DataDirectory = "$env:LOCALAPPDATA\PersonalAiWorker",
  [string]$WorkerExecutable = "$env:LOCALAPPDATA\Programs\PersonalAiWorker\pai-worker.cmd"
)

$taskName = "Personal AI Worker"
if (!(Test-Path -LiteralPath $WorkerExecutable)) { throw "worker executable does not exist: $WorkerExecutable" }
New-Item -ItemType Directory -Force -Path $DataDirectory | Out-Null
foreach ($value in @($DataDirectory, $Origin, $WorkerExecutable)) {
  if ($value.Contains('"') -or $value.Contains("`r") -or $value.Contains("`n")) { throw "arguments must not contain quotes or newlines" }
}
$arguments = "start --origin `"$Origin`" --data-dir `"$DataDirectory`""
$action = New-ScheduledTaskAction -Execute $WorkerExecutable -Argument $arguments -WorkingDirectory (Split-Path $WorkerExecutable)
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Days 3650)
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName $taskName
Write-Output (ConvertTo-Json @{ task = $taskName; origin = $Origin; dataDirectory = $DataDirectory; runLevel = "Limited" })
