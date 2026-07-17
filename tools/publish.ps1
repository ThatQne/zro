# zro publish GUI — one window to review, commit, push, and cut releases.
# Run: tools\publish.cmd  (or: powershell -ExecutionPolicy Bypass -File tools\publish.ps1)
#
# Release flow: bumping the version rewrites package.json, src-tauri/tauri.conf.json
# and src-tauri/Cargo.toml, commits, tags vX.Y.Z and pushes --tags — release.yml
# on GitHub does the actual build + signed updater artifacts.

# Any unhandled error before ShowDialog kills the process instantly — the cmd
# window just flashes and closes with nothing visible ("blank"). Wrap the
# whole body so a failure shows an actual message box instead of vanishing.
trap {
    $msgText = "zro publish failed to start:`r`n`r`n" + $_.Exception.Message + "`r`n`r`n" + $_.InvocationInfo.PositionMessage
    try {
        Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop
        [System.Windows.Forms.MessageBox]::Show($msgText, "zro publish - error", "OK", "Error") | Out-Null
    } catch {
        Write-Host $msgText -ForegroundColor Red
    }
    Write-Host "`r`nPress Enter to close..."
    [void](Read-Host)
    exit 1
}

Write-Host "zro publish: script started. PS $($PSVersionTable.PSVersion), apartment $([System.Threading.Thread]::CurrentThread.ApartmentState)"
Write-Host "zro publish: effective execution policy = $(Get-ExecutionPolicy)"

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()
Write-Host "zro publish: WinForms assemblies loaded"

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    throw "git.exe was not found on PATH. Install Git for Windows (or add it to PATH) and try again."
}
Write-Host "zro publish: git found at $((Get-Command git).Source)"

$repo = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
if (-not $repo -or -not (Test-Path (Join-Path $repo ".git"))) {
    throw "Could not resolve the zro repo root from this script's location ($($MyInvocation.MyCommand.Path))."
}
Set-Location $repo
Write-Host "zro publish: repo root = $repo"

# ── palette (matches the zro site) ────────────────────────────────────────────
$cBg    = [System.Drawing.ColorTranslator]::FromHtml("#080808")
$cPanel = [System.Drawing.ColorTranslator]::FromHtml("#0f0f0f")
$cLine  = [System.Drawing.ColorTranslator]::FromHtml("#232323")
$cFg    = [System.Drawing.ColorTranslator]::FromHtml("#e8e8e8")
$cDim   = [System.Drawing.ColorTranslator]::FromHtml("#888888")
$cBlue  = [System.Drawing.ColorTranslator]::FromHtml("#4f80f5")
$cGreen = [System.Drawing.ColorTranslator]::FromHtml("#4fb56a")
$cAmber = [System.Drawing.ColorTranslator]::FromHtml("#d8a04a")
$mono   = New-Object System.Drawing.Font("Consolas", 9)
$monoSm = New-Object System.Drawing.Font("Consolas", 8.5)

function New-Btn($text, $x, $y, $w, $accent) {
    $b = New-Object System.Windows.Forms.Button
    $b.Text = $text; $b.Location = New-Object System.Drawing.Point($x, $y)
    $b.Size = New-Object System.Drawing.Size($w, 28)
    $b.FlatStyle = "Flat"; $b.Font = $mono
    $b.BackColor = $cPanel; $b.ForeColor = $cFg
    $b.FlatAppearance.BorderColor = $cLine
    if ($accent) { $b.ForeColor = $accent; $b.FlatAppearance.BorderColor = $accent }
    return $b
}

# ── git plumbing ──────────────────────────────────────────────────────────────
# `& git @argv 2>&1 | Out-String` hung indefinitely on the very first call
# (before the window ever showed) — Windows PowerShell 5.1's merged-stream
# native-command redirection is a known deadlock risk. Process + async
# BeginOutputReadLine/BeginErrorReadLine reads both streams concurrently (no
# deadlock), and WaitForExit has a hard timeout so a wedged git (credential
# prompt, hook, AV hook, whatever) can never freeze the GUI again.
function Quote-Arg([string]$a) {
    if ($a -eq "") { return '""' }
    if ($a -notmatch '[\s"]') { return $a }
    $sb = New-Object System.Text.StringBuilder
    [void]$sb.Append('"')
    $i = 0
    while ($i -lt $a.Length) {
        $backslashes = 0
        while ($i -lt $a.Length -and $a[$i] -eq '\') { $backslashes++; $i++ }
        if ($i -eq $a.Length) {
            [void]$sb.Append('\' * ($backslashes * 2))
        } elseif ($a[$i] -eq '"') {
            [void]$sb.Append('\' * ($backslashes * 2 + 1))
            [void]$sb.Append('"')
            $i++
        } else {
            [void]$sb.Append('\' * $backslashes)
            [void]$sb.Append($a[$i])
            $i++
        }
    }
    [void]$sb.Append('"')
    return $sb.ToString()
}

function Invoke-Git([string[]]$argv) {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = (Get-Command git).Source
    $psi.Arguments = ($argv | ForEach-Object { Quote-Arg $_ }) -join " "
    $psi.WorkingDirectory = $repo
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.RedirectStandardInput = $true  # never let git wait on a prompt
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true

    $p = New-Object System.Diagnostics.Process
    $p.StartInfo = $psi
    $outBuf = New-Object System.Text.StringBuilder
    $errBuf = New-Object System.Text.StringBuilder
    $outAction = { if ($null -ne $EventArgs.Data) { [void]$Event.MessageData.Append($EventArgs.Data).Append("`n") } }
    $outSub = Register-ObjectEvent -InputObject $p -EventName OutputDataReceived -Action $outAction -MessageData $outBuf
    $errSub = Register-ObjectEvent -InputObject $p -EventName ErrorDataReceived -Action $outAction -MessageData $errBuf
    try {
        [void]$p.Start()
        $p.StandardInput.Close() # closed stdin = any prompt fails fast instead of hanging
        $p.BeginOutputReadLine()
        $p.BeginErrorReadLine()
        if (-not $p.WaitForExit(20000)) {
            try { $p.Kill() } catch {}
            return "! git $($argv -join ' ') timed out after 20s"
        }
    } finally {
        Unregister-Event -SourceIdentifier $outSub.Name -ErrorAction SilentlyContinue
        Unregister-Event -SourceIdentifier $errSub.Name -ErrorAction SilentlyContinue
    }
    return ($outBuf.ToString() + $errBuf.ToString()).TrimEnd()
}
function Log($text, $color) {
    if ($null -eq $color) { $color = $cDim }
    $log.SelectionStart = $log.TextLength
    $log.SelectionColor = $color
    $log.AppendText($text + "`r`n")
    $log.ScrollToCaret()
}
function RunLogged($label, [string[]]$argv) {
    Log ("> git " + ($argv -join " ")) $cBlue
    $out = Invoke-Git $argv
    if ($out) { Log $out $cDim }
    Log ("- " + $label + " done") $cGreen
}

# ── window ────────────────────────────────────────────────────────────────────
$form = New-Object System.Windows.Forms.Form
$form.Text = "zro publish"
$form.Size = New-Object System.Drawing.Size(920, 660)
$form.StartPosition = "CenterScreen"
$form.BackColor = $cBg
$form.ForeColor = $cFg
$form.Font = $mono

# status: branch + version
$head = New-Object System.Windows.Forms.Label
$head.Location = New-Object System.Drawing.Point(14, 12)
$head.Size = New-Object System.Drawing.Size(600, 18)
$head.ForeColor = $cDim
$form.Controls.Add($head)

# changed files
$files = New-Object System.Windows.Forms.ListBox
$files.Location = New-Object System.Drawing.Point(14, 38)
$files.Size = New-Object System.Drawing.Size(330, 250)
$files.BackColor = $cPanel; $files.ForeColor = $cFg
$files.BorderStyle = "FixedSingle"; $files.Font = $monoSm
$form.Controls.Add($files)

# diff viewer
$diff = New-Object System.Windows.Forms.RichTextBox
$diff.Location = New-Object System.Drawing.Point(354, 38)
$diff.Size = New-Object System.Drawing.Size(536, 250)
$diff.BackColor = $cPanel; $diff.ForeColor = $cDim
$diff.BorderStyle = "FixedSingle"; $diff.Font = $monoSm
$diff.ReadOnly = $true; $diff.WordWrap = $false
$form.Controls.Add($diff)

# commit message
$msg = New-Object System.Windows.Forms.TextBox
$msg.Location = New-Object System.Drawing.Point(14, 300)
$msg.Size = New-Object System.Drawing.Size(646, 26)
$msg.BackColor = $cPanel; $msg.ForeColor = $cFg
$msg.BorderStyle = "FixedSingle"; $msg.Font = $mono
$form.Controls.Add($msg)
$msgHint = New-Object System.Windows.Forms.Label
$msgHint.Text = "commit message"
$msgHint.Location = New-Object System.Drawing.Point(14, 328)
$msgHint.Size = New-Object System.Drawing.Size(300, 15)
$msgHint.ForeColor = $cDim; $msgHint.Font = $monoSm
$form.Controls.Add($msgHint)

$btnRefresh = New-Btn "refresh"      670 299 100 $null
$btnCommit  = New-Btn "commit all"   776 299 114 $cBlue
$btnPush    = New-Btn "push"         776 333 114 $cGreen
$btnPull    = New-Btn "pull"         670 333 100 $null
$form.Controls.AddRange(@($btnRefresh, $btnCommit, $btnPush, $btnPull))

# release row
$relLabel = New-Object System.Windows.Forms.Label
$relLabel.Text = "release"
$relLabel.Location = New-Object System.Drawing.Point(14, 366)
$relLabel.Size = New-Object System.Drawing.Size(80, 18)
$relLabel.ForeColor = $cAmber
$form.Controls.Add($relLabel)

$ver = New-Object System.Windows.Forms.TextBox
$ver.Location = New-Object System.Drawing.Point(100, 362)
$ver.Size = New-Object System.Drawing.Size(110, 26)
$ver.BackColor = $cPanel; $ver.ForeColor = $cFg
$ver.BorderStyle = "FixedSingle"; $ver.Font = $mono
$form.Controls.Add($ver)

$btnRelease = New-Btn "bump + tag + push (triggers release build)" 220 361 440 $cAmber
$form.Controls.Add($btnRelease)

# log
$log = New-Object System.Windows.Forms.RichTextBox
$log.Location = New-Object System.Drawing.Point(14, 400)
$log.Size = New-Object System.Drawing.Size(876, 208)
$log.BackColor = $cPanel; $log.ForeColor = $cDim
$log.BorderStyle = "FixedSingle"; $log.Font = $monoSm
$log.ReadOnly = $true
$form.Controls.Add($log)

# ── behavior ──────────────────────────────────────────────────────────────────
function Get-Version {
    try {
        $conf = Get-Content "$repo\src-tauri\tauri.conf.json" -Raw | ConvertFrom-Json
        return $conf.version
    } catch { return "?" }
}

function Refresh-Status {
    $branch = Invoke-Git @("rev-parse", "--abbrev-ref", "HEAD")
    $ahead = Invoke-Git @("rev-list", "--count", "@{u}..HEAD")
    if ($ahead -notmatch '^\d+$') { $ahead = "?" } # no upstream tracking branch set
    $head.Text = "branch $branch - v$(Get-Version) - $ahead unpushed commit(s)"
    $files.Items.Clear()
    $st = Invoke-Git @("status", "--short")
    if ($st) {
        foreach ($line in ($st -split "`n")) {
            if ($line.Trim()) { [void]$files.Items.Add($line.TrimEnd()) }
        }
    }
    if ($files.Items.Count -eq 0) { [void]$files.Items.Add("  (working tree clean)") }
    $ver.Text = Get-Version
}

$files.Add_SelectedIndexChanged({
    $sel = $files.SelectedItem
    if (-not $sel) { return }
    $path = ($sel.ToString().Substring(3)).Trim()
    if (-not $path) { return }
    $d = Invoke-Git @("diff", "HEAD", "--", $path)
    if (-not $d) { $d = Invoke-Git @("diff", "--cached", "--", $path) }
    if (-not $d) { $d = "(new/untracked file - no diff)" }
    $diff.Clear()
    foreach ($line in ($d -split "`n")) {
        $c = $cDim
        if ($line.StartsWith("+") -and -not $line.StartsWith("+++")) { $c = $cGreen }
        elseif ($line.StartsWith("-") -and -not $line.StartsWith("---")) { $c = [System.Drawing.ColorTranslator]::FromHtml("#d66a5a") }
        elseif ($line.StartsWith("@@")) { $c = $cBlue }
        $diff.SelectionStart = $diff.TextLength
        $diff.SelectionColor = $c
        $diff.AppendText($line.TrimEnd() + "`r`n")
    }
})

$btnRefresh.Add_Click({ Refresh-Status; Log "refreshed" $cDim })
$btnPull.Add_Click({ RunLogged "pull" @("pull", "--rebase"); Refresh-Status })

$btnCommit.Add_Click({
    if (-not $msg.Text.Trim()) { Log "! commit message is empty" $cAmber; return }
    RunLogged "stage" @("add", "-A")
    RunLogged "commit" @("commit", "-m", $msg.Text.Trim())
    $msg.Clear()
    Refresh-Status
})

$btnPush.Add_Click({
    RunLogged "push" @("push")
    Refresh-Status
})

$btnRelease.Add_Click({
    $v = $ver.Text.Trim().TrimStart("v")
    if ($v -notmatch '^\d+\.\d+\.\d+$') { Log "! version must be X.Y.Z" $cAmber; return }
    $st = Invoke-Git @("status", "--short")
    if ($st.Trim()) { Log "! commit or stash changes before releasing" $cAmber; return }
    $confirm = [System.Windows.Forms.MessageBox]::Show(
        "Release v$v`n`nRewrites version in package.json / tauri.conf.json / Cargo.toml, commits, tags v$v and pushes --tags. GitHub Actions then builds and publishes the release.",
        "zro publish", "OKCancel", "Warning")
    if ($confirm -ne "OK") { Log "release cancelled" $cDim; return }

    Log ("releasing v" + $v) $cAmber
    # package.json + tauri.conf.json (regex keeps formatting; ConvertTo-Json would reflow)
    foreach ($f in @("package.json", "src-tauri\tauri.conf.json")) {
        $p = Join-Path $repo $f
        $txt = Get-Content $p -Raw
        $txt = $txt -replace '"version"\s*:\s*"\d+\.\d+\.\d+"', ('"version": "' + $v + '"')
        [System.IO.File]::WriteAllText($p, $txt)   # no BOM, keeps LF
        Log ("  bumped " + $f) $cDim
    }
    $p = Join-Path $repo "src-tauri\Cargo.toml"
    $txt = Get-Content $p -Raw
    $txt = $txt -replace '(?m)^version\s*=\s*"\d+\.\d+\.\d+"', ('version = "' + $v + '"')
    [System.IO.File]::WriteAllText($p, $txt)
    Log "  bumped src-tauri\Cargo.toml" $cDim

    RunLogged "stage" @("add", "package.json", "src-tauri/tauri.conf.json", "src-tauri/Cargo.toml", "src-tauri/Cargo.lock")
    RunLogged "commit" @("commit", "-m", ("release: v" + $v))
    RunLogged "tag" @("tag", ("v" + $v))
    RunLogged "push" @("push")
    RunLogged "push tags" @("push", "--tags")
    Log ("v" + $v + " pushed - watch the Actions tab for the build") $cGreen
    Refresh-Status
})

# stale tokens make git/gh pick the wrong account on this machine
Remove-Item Env:GH_TOKEN -ErrorAction SilentlyContinue
Remove-Item Env:GITHUB_TOKEN -ErrorAction SilentlyContinue

Write-Host "zro publish: form built, calling Refresh-Status"
Refresh-Status
Log "zro publish - repo: $repo" $cBlue
Write-Host "zro publish: showing window now"
[void]$form.ShowDialog()
Write-Host "zro publish: window closed, exiting"
