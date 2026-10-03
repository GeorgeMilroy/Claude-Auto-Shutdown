# capture-region.ps1 - test tool, used only by the opt-in live test of the countdown window.
#
# Saves a picture of the bottom-right corner of the primary screen (exactly where the countdown
# window sits) so that a person can check what the window looks like. It prints READY once it is
# loaded, waits for the trigger file to appear, takes the picture and prints SAVED.
param(
    [Parameter(Mandatory = $true)][string]$OutFile,
    [Parameter(Mandatory = $true)][string]$TriggerFile,
    [int]$Width = 380,
    [int]$Height = 230,
    [int]$Margin = 16,
    [int]$WaitSeconds = 15
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$area = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
$left = $area.Right - $Margin - $Width
$top = $area.Bottom - $Margin - $Height
$bitmap = New-Object System.Drawing.Bitmap($Width, $Height)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)

[Console]::Out.WriteLine('READY')
[Console]::Out.Flush()

$deadline = (Get-Date).AddSeconds($WaitSeconds)
while (-not (Test-Path -LiteralPath $TriggerFile)) {
    if ((Get-Date) -gt $deadline) { exit 2 }
    Start-Sleep -Milliseconds 25
}

$graphics.CopyFromScreen($left, $top, 0, 0, $bitmap.Size)
$bitmap.Save($OutFile, [System.Drawing.Imaging.ImageFormat]::Png)
$graphics.Dispose()
$bitmap.Dispose()
[Console]::Out.WriteLine('SAVED')
[Console]::Out.Flush()
exit 0
