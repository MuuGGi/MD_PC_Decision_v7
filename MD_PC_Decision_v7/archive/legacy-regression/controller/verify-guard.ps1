$ErrorActionPreference = 'Stop'
# Compile only. Never call GetForegroundWindow, GuardArm, or input APIs.
$taskSource = Get-Content -Raw -LiteralPath "$PSScriptRoot\engine\scripts\md-common.ps1"
$taskCode = [regex]::Match($taskSource, '(?s)Add-Type @"\r?\n(.*?)\r?\n"@').Groups[1].Value
if (-not $taskCode) { throw 'GUARD_CSHARP_SOURCE_MISSING' }
Add-Type -TypeDefinition $taskCode
# Exercise the actual production predicate without reading the live cursor or
# calling any user32 API. 12 inclusive; 13 on either axis must still stop.
$taskToleranceMethod = [MDWin32].GetMethod('CursorOutsideTolerance', ([System.Reflection.BindingFlags]::NonPublic -bor [System.Reflection.BindingFlags]::Static))
if (-not $taskToleranceMethod) { throw 'GUARD_MOUSE_TOLERANCE_METHOD_MISSING' }
$taskToleranceCases = @(
    @{ dx = 0; dy = 0; outside = $false },
    @{ dx = 5; dy = -5; outside = $false },
    @{ dx = 12; dy = 12; outside = $false },
    @{ dx = -12; dy = -12; outside = $false },
    @{ dx = 13; dy = 0; outside = $true },
    @{ dx = -13; dy = 0; outside = $true },
    @{ dx = 0; dy = 13; outside = $true },
    @{ dx = 0; dy = -13; outside = $true },
    @{ dx = 100; dy = 100; outside = $true }
)
foreach ($taskCase in $taskToleranceCases) {
    $taskArguments = [object[]]@([int]884, [int]294, [int](884 + $taskCase.dx), [int](294 + $taskCase.dy))
    $taskOutside = [bool]$taskToleranceMethod.Invoke($null, $taskArguments)
    if ($taskOutside -ne $taskCase.outside) { throw ('GUARD_MOUSE_TOLERANCE_BOUNDARY_INVALID:' + ($taskCase | Out-String)) }
}
$taskIdentityMethod = [MDWin32].GetMethod('ForegroundIdentityReason', ([System.Reflection.BindingFlags]::NonPublic -bor [System.Reflection.BindingFlags]::Static))
$taskIdentityCases = @(
    @{ actual=1234; root=1234; actualPid=56; rootPid=56; title='masterduel'; visible=$true; reason=$null },
    @{ actual=9999; root=1234; actualPid=56; rootPid=56; title='Master Duel'; visible=$true; reason=$null },
    @{ actual=9999; root=9999; actualPid=56; rootPid=56; title='masterduel'; visible=$true; reason='MASTER_DUEL_WINDOW_CHANGED' },
    @{ actual=9999; root=9999; actualPid=56; rootPid=56; title='Owned dialog'; visible=$true; reason='MASTER_DUEL_WINDOW_CHANGED' },
    @{ actual=9999; root=9999; actualPid=78; rootPid=78; title='Codex'; visible=$true; reason='FOREGROUND_LOST' },
    @{ actual=1234; root=1234; actualPid=78; rootPid=78; title='masterduel'; visible=$true; reason='FOREGROUND_LOST' },
    @{ actual=9999; root=1234; actualPid=78; rootPid=56; title='masterduel'; visible=$true; reason='FOREGROUND_LOST' },
    @{ actual=0; root=0; actualPid=0; rootPid=0; title=''; visible=$false; reason='FOREGROUND_IDENTITY_UNPROVEN' },
    @{ actual=1234; root=1234; actualPid=56; rootPid=56; title='Other'; visible=$true; reason='FOREGROUND_IDENTITY_UNPROVEN' },
    @{ actual=1234; root=1234; actualPid=56; rootPid=56; title='masterduel'; visible=$false; reason='FOREGROUND_IDENTITY_UNPROVEN' }
)
foreach ($taskCase in $taskIdentityCases) {
    $taskArguments = [object[]]@([long]1234, [uint32]56, [long]$taskCase.actual, [long]$taskCase.root,
        [uint32]$taskCase.actualPid, [uint32]$taskCase.rootPid, [string]$taskCase.title, [bool]$taskCase.visible)
    if ($taskIdentityMethod.Invoke($null, $taskArguments) -ne $taskCase.reason) { throw 'GUARD_FOREGROUND_IDENTITY_POLICY_INVALID' }
}
Add-Type -TypeDefinition @'
using System.IO;
using System.Threading;
public static class GuardWriteLockTest {
    public static Thread Hold(string path, int milliseconds, EventWaitHandle ready) {
        Thread thread = new Thread(delegate() {
            using (FileStream stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read)) {
                ready.Set();
                Thread.Sleep(milliseconds);
            }
        });
        thread.IsBackground = true;
        thread.Start();
        return thread;
    }
}
'@
# Existing STOP must block every native input BEFORE any user32 call.
$taskEvidence = Join-Path $PSScriptRoot 'test-evidence'
[void][System.IO.Directory]::CreateDirectory($taskEvidence)
$taskStop = Join-Path $taskEvidence 'compile-only-stop.txt'
[System.IO.File]::WriteAllText($taskStop, 'USER_STOP')
$env:MD_AUTOTEST_GUARD = Join-Path $taskEvidence 'compile-only-guard.txt'
$env:MD_AUTOTEST_STOP = $taskStop
$taskBlocked = 0
foreach ($taskAction in @('MOVE', 'DOWN', 'KEY')) {
    try {
        if ($taskAction -eq 'MOVE') { [void][MDWin32]::SetCursorPos(0, 0) }
        elseif ($taskAction -eq 'DOWN') { [MDWin32]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero) }
        else { [MDWin32]::keybd_event(0x49, 0, 0, [UIntPtr]::Zero) }
        throw 'GUARD_FAILED_TO_BLOCK_INPUT'
    } catch {
        if ($_.Exception.ToString() -notmatch 'AUTOTEST_STOP:USER_STOP') { throw }
        $taskBlocked++
    }
}
if ($taskBlocked -ne 3) { throw 'GUARD_INPUT_BLOCK_COUNT_INVALID' }
$taskGuardWrite = Join-Path $taskEvidence ('guard-write-' + [Guid]::NewGuid().ToString() + '.txt')
$env:MD_AUTOTEST_GUARD = $taskGuardWrite
$env:MD_AUTOTEST_STOP = $taskGuardWrite + '.stop'
$taskFailureMethod = [MDWin32].GetMethod('WriteFirstGuardFailure', ([System.Reflection.BindingFlags]::NonPublic -bor [System.Reflection.BindingFlags]::Static))
[void]$taskFailureMethod.Invoke($null, [object[]]@('{"reason":"FIRST","title":"测试窗口"}'))
try { [void]$taskFailureMethod.Invoke($null, [object[]]@('{"reason":"SECOND"}')); throw 'GUARD_FIRST_FAILURE_OVERWRITTEN' }
catch { if ($_.Exception.ToString() -match 'GUARD_FIRST_FAILURE_OVERWRITTEN') { throw } }
$taskDiagnostic = [System.IO.File]::ReadAllText($taskGuardWrite + '.failure.json') | ConvertFrom-Json
if ($taskDiagnostic.reason -ne 'FIRST' -or $taskDiagnostic.title -ne '测试窗口') { throw 'GUARD_FIRST_FAILURE_OR_UTF8_INVALID' }
$taskWriteMethod = [MDWin32].GetMethod('WriteGuard', ([System.Reflection.BindingFlags]::NonPublic -bor [System.Reflection.BindingFlags]::Static))
if (-not $taskWriteMethod) { throw 'GUARD_WRITE_METHOD_MISSING' }
$taskValues = [string[]]@('1234', '100', '200', '2048', '1152', '28', '99', '0')
$taskInvoke = [object[]]::new(1)
$taskInvoke[0] = $taskValues
[void]$taskWriteMethod.Invoke($null, $taskInvoke)
$taskValues[1] = '300'
$taskValues[2] = '400'
[System.Threading.ManualResetEvent]$taskReady = New-Object System.Threading.ManualResetEvent($false)
$taskLockThread = [GuardWriteLockTest]::Hold($taskGuardWrite, 80, $taskReady)
if (-not $taskReady.WaitOne(2000)) { throw 'GUARD_TRANSIENT_LOCK_SETUP_FAILED' }
[void]$taskWriteMethod.Invoke($null, $taskInvoke)
$taskLockThread.Join()
if ([System.IO.File]::ReadAllText($taskGuardWrite) -ne '1234|300|400|2048|1152|28|99|0') { throw 'GUARD_REPLACE_CONTENT_INVALID' }
if ((Get-ChildItem -LiteralPath $taskEvidence -Filter ((Split-Path -Leaf $taskGuardWrite) + '.*.tmp')).Count -ne 0) { throw 'GUARD_TEMP_FILE_LEAK' }
$taskMissing = Join-Path $taskEvidence ('guard-missing-' + [Guid]::NewGuid().ToString())
$env:MD_AUTOTEST_STOP = $taskMissing
$env:MD_AUTOTEST_GUARD = $taskMissing + '.guard'
[System.IO.File]::WriteAllText($taskMissing + '.armed', 'ARMED')
try {
    [MDWin32]::GuardCheck()
    throw 'MISSING_ARMED_GUARD_ALLOWED_INPUT'
} catch {
    if ($_.Exception.ToString() -notmatch 'AUTOTEST_STOP:GUARD_STATE_MISSING') { throw }
}
foreach ($taskFile in @('engine\scripts\md-common.ps1', 'engine\scripts\md-server.ps1')) {
    $taskTokens = $null
    $taskErrors = $null
    [void][System.Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot $taskFile), [ref]$taskTokens, [ref]$taskErrors)
    if ($taskErrors.Count -gt 0) { throw ($taskErrors | Out-String) }
}
Write-Output 'AUTOTEST_NATIVE_GUARD_COMPILE_AND_PS_PARSE_PASS; root+PID+title identity/owned dialog/reused handle; first failure immutable UTF8; mouse12/13; atomic writer; STOP blocks input; nativeInputCalls=0'
