# win-countdown-alert.ps1 - Claude Auto Shutdown, countdown warning window
#
# KEEP THIS FILE PURE ASCII. Windows PowerShell 5.1 reads a BOM-less .ps1 as the ANSI code page.
#
# Shows ONE small always-on-top window in the bottom-right corner of the primary screen and does
# nothing else: no power action, no file access, no network. The extension decides what happens
# when the countdown ends; this window only displays it and reports a click.
#
# stdout, one word per line:
#   SHOWN   the window is on screen
#   CANCEL  the user pressed the button, pressed Esc / Enter, or closed the window
# The extension ends the countdown by killing this process. As a backstop the window closes by
# itself (printing nothing) a few seconds after reaching zero, or when -ParentPid is gone.
#
# The window counts down to -DeadlineUnixMs, an absolute time (Unix ms, UTC) the extension fixed
# when it asked for the window. Starting PowerShell and WinForms takes seconds; with an absolute
# deadline that time is already spent when the window appears, so it never shows more time than
# really remains. -Seconds caps it: the deadline is never later than -Seconds from now.
#
# The texts arrive in environment variables, never as arguments: a text that starts with '-'
# would be taken for a parameter name.
#   CAS_ALERT_TITLE   first line                  e.g. "Shutting down this PC in"
#   CAS_ALERT_BODY    line under the digits       e.g. "All Claude sessions finished."
#   CAS_ALERT_CANCEL  label of the one button     e.g. "Cancel: keep this PC on"
#   CAS_ALERT_BADGE   strip across the top for a test run / preview (empty for the real thing)
param(
    [ValidateRange(1, 86400)][int]$Seconds = 60,
    [long]$DeadlineUnixMs = 0,
    [ValidateSet('real', 'test', 'preview')][string]$Kind = 'preview',
    [int]$ParentPid = 0,
    [switch]$Sound
)

$ErrorActionPreference = 'Stop'

function Get-UnixMs {
    return [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
}

# The given deadline, but never later than $seconds from now (a missing one, or a clock that went
# back after the extension asked, would otherwise show more time than remains).
function Get-AlertDeadline([long]$givenMs, [long]$nowMs, [int]$seconds) {
    $latestMs = $nowMs + ([long]$seconds * 1000)
    if ($givenMs -le 0 -or $givenMs -gt $latestMs) { return $latestMs }
    return $givenMs
}

# Whole seconds until the deadline, rounded DOWN, never below zero.
function Get-SecondsLeft([long]$deadlineMs, [long]$nowMs) {
    $left = [Math]::Floor(($deadlineMs - $nowMs) / 1000)
    if ($left -lt 0) { return 0 }
    return [int]$left
}

$deadline = Get-AlertDeadline $DeadlineUnixMs (Get-UnixMs) $Seconds

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

function Get-AlertText([string]$name, [string]$fallback, [int]$max) {
    $value = [Environment]::GetEnvironmentVariable($name)
    if ([string]::IsNullOrWhiteSpace($value)) { return $fallback }
    $value = $value.Trim()
    if ($value.Length -gt $max) { $value = $value.Substring(0, $max) }
    return $value
}

function New-AlertLabel([string]$text, [int]$x, [int]$y, [int]$width, [int]$height, $font, $color) {
    $label = New-Object System.Windows.Forms.Label
    $label.Text = $text
    $label.AutoSize = $false
    $label.AutoEllipsis = $true
    $label.UseMnemonic = $false
    $label.Location = New-Object System.Drawing.Point($x, $y)
    $label.Size = New-Object System.Drawing.Size($width, $height)
    $label.Font = $font
    $label.ForeColor = $color
    $label.BackColor = [System.Drawing.Color]::Transparent
    return $label
}

function Format-Remaining([int]$left) {
    return ('{0}:{1:00}' -f [int][Math]::Floor($left / 60), ($left % 60))
}

# An error inside a window event would pop up a .NET error dialog, so nothing here may throw:
# a closed stdout (the extension is gone) is simply ignored.
function Write-Signal([string]$word) {
    try {
        [Console]::Out.WriteLine($word)
        [Console]::Out.Flush()
    }
    catch { }
}

$titleText = Get-AlertText 'CAS_ALERT_TITLE' 'Claude Auto Shutdown' 120
$bodyText = Get-AlertText 'CAS_ALERT_BODY' '' 240
$cancelText = Get-AlertText 'CAS_ALERT_CANCEL' 'Cancel' 60
$badgeText = Get-AlertText 'CAS_ALERT_BADGE' '' 80

# Real = thick red frame and amber digits. Test run / preview = thin blue frame and a labelled strip.
$isReal = ($Kind -eq 'real')
if ($isReal) {
    $accent = [System.Drawing.Color]::FromArgb(209, 52, 56)
    $digitColor = [System.Drawing.Color]::FromArgb(255, 200, 60)
    $frame = 6
}
else {
    $accent = [System.Drawing.Color]::FromArgb(15, 108, 189)
    $digitColor = [System.Drawing.Color]::White
    $frame = 3
}
$surface = [System.Drawing.Color]::FromArgb(32, 32, 32)
$white = [System.Drawing.Color]::White
$muted = [System.Drawing.Color]::FromArgb(205, 205, 205)

$width = 380
$inner = $width - (2 * $frame)
$margin = 16
$content = $inner - (2 * $margin)

$fontTitle = New-Object System.Drawing.Font('Segoe UI', 11, [System.Drawing.FontStyle]::Bold)
$fontDigits = New-Object System.Drawing.Font('Segoe UI', 34, [System.Drawing.FontStyle]::Bold)
$fontBody = New-Object System.Drawing.Font('Segoe UI', 9.5)
$fontBadge = New-Object System.Drawing.Font('Segoe UI', 8.5, [System.Drawing.FontStyle]::Bold)

$panel = New-Object System.Windows.Forms.Panel
$panel.BackColor = $surface
$panel.Dock = [System.Windows.Forms.DockStyle]::Fill

$y = 0
if ($badgeText.Length -gt 0) {
    $badge = New-AlertLabel $badgeText 0 0 $inner 26 $fontBadge $white
    $badge.BackColor = $accent
    $badge.TextAlign = [System.Drawing.ContentAlignment]::MiddleCenter
    $panel.Controls.Add($badge)
    $y = 26
}
$y += 12
$title = New-AlertLabel $titleText $margin $y $content 24 $fontTitle $white
$panel.Controls.Add($title)
$y += 24
$digits = New-AlertLabel (Format-Remaining (Get-SecondsLeft $deadline (Get-UnixMs))) ($margin - 6) $y ($content + 6) 64 $fontDigits $digitColor
$digits.TextAlign = [System.Drawing.ContentAlignment]::MiddleLeft
$panel.Controls.Add($digits)
$y += 64
if ($bodyText.Length -gt 0) {
    $body = New-AlertLabel $bodyText $margin $y $content 38 $fontBody $muted
    $panel.Controls.Add($body)
    $y += 38
}
$y += 8
$button = New-Object System.Windows.Forms.Button
$button.Text = $cancelText
$button.UseMnemonic = $false
$button.Location = New-Object System.Drawing.Point($margin, $y)
$button.Size = New-Object System.Drawing.Size($content, 36)
$button.Font = $fontTitle
$button.FlatStyle = [System.Windows.Forms.FlatStyle]::Flat
$button.FlatAppearance.BorderSize = 1
$button.FlatAppearance.BorderColor = $accent
$button.BackColor = [System.Drawing.Color]::FromArgb(58, 58, 58)
$button.ForeColor = $white
$button.Cursor = [System.Windows.Forms.Cursors]::Hand
$panel.Controls.Add($button)
$y += 36 + $margin

$form = New-Object System.Windows.Forms.Form
$form.Text = 'Claude Auto Shutdown'
$form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
$form.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
$form.ShowInTaskbar = $false
$form.TopMost = $true
$form.BackColor = $accent
$form.Padding = New-Object System.Windows.Forms.Padding($frame)
$form.ClientSize = New-Object System.Drawing.Size($width, ($y + (2 * $frame)))
$form.Controls.Add($panel)
$form.AcceptButton = $button
$form.CancelButton = $button

$area = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
$form.Location = New-Object System.Drawing.Point(($area.Right - $form.Width - 16), ($area.Bottom - $form.Height - 16))

# Event handlers run in their own scope: shared state lives in one object they can change.
$state = @{ Displayed = (Get-SecondsLeft $deadline (Get-UnixMs)); ClosedByTimer = $false }

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 200
$timer.Add_Tick({
    try {
        $now = Get-UnixMs
        $left = Get-SecondsLeft $deadline $now
        $parentGone = $false
        if ($left -ne $state.Displayed) {
            $state.Displayed = $left
            $digits.Text = Format-Remaining $left
            if ($Sound -and $left -ge 1 -and $left -le 5) { [System.Media.SystemSounds]::Exclamation.Play() }
            if ($ParentPid -gt 0) { $parentGone = ($null -eq (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) }
        }
        if ($parentGone -or $now -gt ($deadline + 5000)) {
            $state.ClosedByTimer = $true
            $form.Close()
        }
    }
    catch { }
})

$button.Add_Click({ $form.Close() })

$form.Add_Shown({
    try {
        $timer.Start()
        if ($Sound) { [System.Media.SystemSounds]::Exclamation.Play() }
    }
    catch { }
    Write-Signal 'SHOWN'
})

# Only a person closing the window is a cancel: not the timer above, and not Windows closing every
# window because the PC is shutting down.
$form.Add_FormClosed({
    $timer.Stop()
    if (-not $state.ClosedByTimer -and $_.CloseReason -eq [System.Windows.Forms.CloseReason]::UserClosing) { Write-Signal 'CANCEL' }
})

# The extension starts this process hidden so that no console window flashes up, and Windows applies
# that "hidden" request to the first window a process shows. A throw-away, fully transparent window
# takes it; the real one is then shown normally.
$decoy = New-Object System.Windows.Forms.Form
$decoy.ShowInTaskbar = $false
$decoy.Opacity = 0
$decoy.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
$decoy.Location = New-Object System.Drawing.Point(-32000, -32000)
$decoy.Size = New-Object System.Drawing.Size(1, 1)
$decoy.Show()
$decoy.Close()
$decoy.Dispose()

[System.Windows.Forms.Application]::Run($form)
exit 0
