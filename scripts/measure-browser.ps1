# Read-only process-tree sampler. Does not launch/close browsers or read URLs.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidateRange(1, 2147483647)][int]$BrowserProcessId,
    [ValidateRange(2, 3600)][int]$Samples = 30,
    [ValidateRange(1, 60)][int]$IntervalSeconds = 2
)
$ErrorActionPreference = 'Stop'
$rootProcess = Get-Process -Id $BrowserProcessId
$rootStarted = $rootProcess.StartTime.ToUniversalTime()
$coreCount = [Environment]::ProcessorCount
$previous = @{}
$records = [System.Collections.Generic.List[object]]::new()
$watch = [Diagnostics.Stopwatch]::StartNew()
$lastSampleAt = 0.0

for ($sample = 0; $sample -lt $Samples; $sample++) {
    $rootCheck = Get-Process -Id $BrowserProcessId -ErrorAction SilentlyContinue
    if (-not $rootCheck -or $rootCheck.StartTime.ToUniversalTime() -ne $rootStarted) {
        throw 'The selected browser exited or its PID was reused. Sampling stopped.'
    }
    # Transitive closure, not a fixed two-level assumption. Only IDs/parents
    # are queried: profile paths, command lines and page URLs stay private.
    $parents = @(Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId)
    $tree = [System.Collections.Generic.HashSet[int]]::new()
    [void]$tree.Add($BrowserProcessId)
    do {
        $changed = $false
        foreach ($entry in $parents) {
            if ($tree.Contains([int]$entry.ParentProcessId) -and $tree.Add([int]$entry.ProcessId)) {
                $changed = $true
            }
        }
    } while ($changed)
    $privateBytes = 0L
    $workingBytes = 0L
    $deltaCpu = 0.0
    $count = 0
    $current = @{}
    foreach ($childId in $tree) {
        $child = Get-Process -Id $childId -ErrorAction SilentlyContinue
        if (-not $child) { continue }
        try {
            $key = "$childId/$($child.StartTime.ToUniversalTime().Ticks)"
            $cpuSeconds = $child.TotalProcessorTime.TotalSeconds
            $privateBytes += $child.PrivateMemorySize64
            $workingBytes += $child.WorkingSet64
            $count++
            if ($previous.ContainsKey($key)) { $deltaCpu += [Math]::Max(0, $cpuSeconds - $previous[$key]) }
            $current[$key] = $cpuSeconds
        } catch { continue } # process exited between enumeration and reading
    }
    $sampleAt = $watch.Elapsed.TotalSeconds
    $cpu = if ($sample -eq 0) { $null } else {
        [Math]::Round(100 * $deltaCpu / ($sampleAt - $lastSampleAt) / $coreCount, 3)
    }
    $records.Add([pscustomobject]@{
        elapsed_seconds = [Math]::Round($sampleAt, 3)
        process_count = $count
        private_commit_mb = [Math]::Round($privateBytes / 1MB, 2)
        working_set_sum_mb = [Math]::Round($workingBytes / 1MB, 2)
        cpu_machine_percent = $cpu
    })
    $lastSampleAt = $sampleAt
    $previous = $current
    if ($sample + 1 -lt $Samples) { Start-Sleep -Seconds $IntervalSeconds }
}
[pscustomobject]@{
    schema_version = 1
    process_name = $rootProcess.ProcessName
    root_pid = $BrowserProcessId
    logical_processors = $coreCount
    captured_at_utc = [DateTime]::UtcNow.ToString('o')
    notes = @(
        'Private commit is allocated private memory, not resident RAM.'
        'Working-set sum double-counts shared pages; do not call it physical RAM usage.'
        'CPU is normalized to whole-machine capacity; first sample is unavailable.'
        'CPU excludes intervals for new/exited processes; use ETW for short-lived process accounting.'
        'Process discovery adds sampler overhead. Compare equivalent runs; not a page-load benchmark.'
    )
    samples = $records.ToArray()
} | ConvertTo-Json -Depth 5
