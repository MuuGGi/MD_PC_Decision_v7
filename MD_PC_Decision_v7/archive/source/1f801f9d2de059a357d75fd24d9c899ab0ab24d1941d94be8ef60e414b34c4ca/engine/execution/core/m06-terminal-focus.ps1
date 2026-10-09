param(
    [ValidateSet('Capture', 'Restore')][string]$Mode = 'Capture',
    [long]$WindowHandle = 0,
    [int]$ExpectedProcessId = 0
)
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\..\..\scripts\md-common.ps1"
if ($Mode -eq 'Capture') {
    $handle = [MDWin32]::GetForegroundWindow()
    $builder = New-Object System.Text.StringBuilder 512
    [void][MDWin32]::GetWindowText($handle, $builder, $builder.Capacity)
    $windowProcess = 0
    [void][MDWin32]::GetWindowThreadProcessId($handle, [ref]$windowProcess)
    if ($handle -eq [IntPtr]::Zero -or $builder.ToString() -match 'master\s?duel') {
        throw 'Start this test from the VS Code terminal.'
    }
    @{ handle = $handle.ToInt64().ToString(); processId = $windowProcess } | ConvertTo-Json -Compress
    exit
}
$handle = [IntPtr]$WindowHandle
$windowProcess = 0
$targetThread = [MDWin32]::GetWindowThreadProcessId($handle, [ref]$windowProcess)
if ($windowProcess -ne $ExpectedProcessId -or $windowProcess -le 0) {
    throw 'The original terminal window is no longer available.'
}
# Same foreground-switch mechanism as the mature game activator, targeting
# only the original terminal handle. No keyboard or mouse events are sent.
[void][MDWin32]::ShowWindow($handle, 9)
$shell = New-Object -ComObject WScript.Shell
[void]$shell.AppActivate($windowProcess)
Start-Sleep -Milliseconds 200
$foreground = [MDWin32]::GetForegroundWindow()
$foregroundProcess = 0
$foregroundThread = [MDWin32]::GetWindowThreadProcessId($foreground, [ref]$foregroundProcess)
$attached = $false
try {
    if ($foregroundThread -gt 0 -and $targetThread -gt 0 -and $foregroundThread -ne $targetThread) {
        $attached = [MDWin32]::AttachThreadInput($foregroundThread, $targetThread, $true)
    }
    [void][MDWin32]::SetForegroundWindow($handle)
} finally {
    if ($attached) { [void][MDWin32]::AttachThreadInput($foregroundThread, $targetThread, $false) }
}
Start-Sleep -Milliseconds 200
if ([MDWin32]::GetForegroundWindow() -ne $handle) { throw 'Terminal foreground restoration failed.' }
Write-Output '{"ok":true}'
