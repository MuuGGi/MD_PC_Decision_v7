Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;

public static class MDWin32
{
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct POINT
    {
        public int X;
        public int Y;
    }

    [DllImport("user32.dll")]
    public static extern bool SetProcessDpiAwarenessContext(IntPtr value);

    [DllImport("user32.dll")]
    public static extern bool SetProcessDPIAware();

    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")]
    public static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);

    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);

    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);

    [DllImport("user32.dll")]
    public static extern bool GetClientRect(IntPtr hWnd, out RECT rect);

    [DllImport("user32.dll")]
    public static extern bool ClientToScreen(IntPtr hWnd, ref POINT point);

    [DllImport("user32.dll")]
    public static extern int GetSystemMetrics(int index);

    [DllImport("user32.dll", EntryPoint = "SetCursorPos")]
    private static extern bool NativeSetCursorPos(int X, int Y);

    [DllImport("user32.dll", EntryPoint = "mouse_event")]
    private static extern void NativeMouseEvent(uint dwFlags, uint dx, uint dy, int dwData, UIntPtr dwExtraInfo);

    [DllImport("user32.dll", EntryPoint = "keybd_event")]
    private static extern void NativeKeyEvent(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
    [DllImport("user32.dll")]
    public static extern bool GetCursorPos(out POINT point);
    [DllImport("user32.dll")]
    private static extern short GetAsyncKeyState(int key);

    private static string GuardPath { get { return Environment.GetEnvironmentVariable("MD_AUTOTEST_GUARD"); } }
    private static string StopPath { get { return Environment.GetEnvironmentVariable("MD_AUTOTEST_STOP"); } }
    private static string GuardOperation = "UNKNOWN";
    public static void SetGuardOperation(string operation) { GuardOperation = operation; }
    private static bool GameTitle(string title) {
        string value = (title ?? "").ToLowerInvariant();
        return value.Contains("masterduel") || value.Contains("master duel");
    }
    // GA_ROOT, not GA_ROOTOWNER: an owned dialog is NOT the playable client.
    private static string ForegroundIdentityReason(long expected, uint expectedPid,
        long actual, long root, uint actualPid, uint rootPid, string title, bool visible) {
        if (actual == 0 || expectedPid == 0 || actualPid == 0 || rootPid == 0) return "FOREGROUND_IDENTITY_UNPROVEN";
        if (actualPid != expectedPid || rootPid != expectedPid) return "FOREGROUND_LOST";
        if (root != expected) return "MASTER_DUEL_WINDOW_CHANGED";
        if (!visible || !GameTitle(title)) return "FOREGROUND_IDENTITY_UNPROVEN";
        return null;
    }
    private static string WindowTitle(IntPtr hwnd) {
        StringBuilder title = new StringBuilder(512);
        GetWindowText(hwnd, title, title.Capacity);
        return title.ToString();
    }
    private static string JsonString(string value) {
        StringBuilder result = new StringBuilder("\"");
        foreach (char c in value ?? "") {
            if (c == '\\' || c == '"') result.Append('\\').Append(c);
            else if (c < 32) result.Append("\\u").Append(((int)c).ToString("x4"));
            else result.Append(c);
        }
        return result.Append('"').ToString();
    }
    private static void WriteFirstGuardFailure(string payload) {
        if (String.IsNullOrEmpty(GuardPath)) return;
        using (System.IO.FileStream file = new System.IO.FileStream(GuardPath + ".failure.json",
            System.IO.FileMode.CreateNew, System.IO.FileAccess.Write, System.IO.FileShare.Read)) {
            byte[] bytes = new UTF8Encoding(false).GetBytes(payload);
            file.Write(bytes, 0, bytes.Length);
            file.Flush(true);
        }
    }
    private static void HaltWithEvidence(string reason, string[] expected, IntPtr foreground, IntPtr root,
        uint foregroundPid, uint rootPid) {
        // Diagnostic reads only; never activate, capture the desktop or input.
        try {
            POINT cursor, origin = new POINT(); RECT client;
            GetCursorPos(out cursor); GetClientRect(root, out client); ClientToScreen(root, ref origin);
            string name = "UNKNOWN";
            try { name = System.Diagnostics.Process.GetProcessById((int)foregroundPid).ProcessName; } catch { }
            string payload = "{\"version\":1,\"at\":" + JsonString(DateTime.UtcNow.ToString("o")) +
                ",\"reason\":" + JsonString(reason) + ",\"command\":" + JsonString(GuardOperation) +
                ",\"expectedGuard\":" + JsonString(String.Join("|", expected)) +
                ",\"foregroundHwnd\":" + foreground.ToInt64() + ",\"foregroundRootHwnd\":" + root.ToInt64() +
                ",\"foregroundPid\":" + foregroundPid + ",\"rootPid\":" + rootPid +
                ",\"foregroundTitle\":" + JsonString(WindowTitle(foreground)) +
                ",\"rootTitle\":" + JsonString(WindowTitle(root)) + ",\"processName\":" + JsonString(name) +
                ",\"cursorX\":" + cursor.X + ",\"cursorY\":" + cursor.Y +
                ",\"clientWidth\":" + client.Right + ",\"clientHeight\":" + client.Bottom +
                ",\"clientX\":" + origin.X + ",\"clientY\":" + origin.Y + "}";
            WriteFirstGuardFailure(payload);
        } catch { /* First snapshot is immutable; diagnostics must not bypass a stop. */ }
        Halt(reason);
    }
    private static void Halt(string reason) {
        if (!String.IsNullOrEmpty(StopPath) && !System.IO.File.Exists(StopPath))
            System.IO.File.WriteAllText(StopPath, reason);
        throw new InvalidOperationException("AUTOTEST_STOP:" + reason);
    }
    private static void WriteGuard(string[] values) {
        string payload = String.Join("|", values);
        string tmp = GuardPath + "." + System.Diagnostics.Process.GetCurrentProcess().Id + "." +
            Guid.NewGuid().ToString("N") + ".tmp";
        Exception last = null;
        try {
            System.IO.File.WriteAllText(tmp, payload);
            // ReplaceFile can transiently fail on Windows when a scanner or a
            // diagnostic reader has the destination open without delete sharing.
            // All automation participants already hold InputMutex here, so a
            // short bounded retry is safe and does not weaken interference checks.
            for (int attempt = 0; attempt < 20; attempt++) {
                try {
                    if (System.IO.File.Exists(GuardPath)) System.IO.File.Replace(tmp, GuardPath, null);
                    else System.IO.File.Move(tmp, GuardPath);
                    return;
                }
                catch (System.IO.IOException ex) { last = ex; }
                catch (UnauthorizedAccessException ex) { last = ex; }
                System.Threading.Thread.Sleep(10);
            }
            // The named mutex keeps every guard reader out while this fallback
            // writes in place.  A crash can only produce an unreadable guard,
            // which remains fail-closed on the next GuardCheck.
            for (int attempt = 0; attempt < 20; attempt++) {
                try {
                    System.IO.File.WriteAllText(GuardPath, payload);
                    return;
                }
                catch (System.IO.IOException ex) { last = ex; }
                catch (UnauthorizedAccessException ex) { last = ex; }
                System.Threading.Thread.Sleep(10);
            }
            throw new System.IO.IOException("AUTOTEST_GUARD_WRITE_FAILED", last);
        }
        finally {
            try { if (System.IO.File.Exists(tmp)) System.IO.File.Delete(tmp); } catch { }
        }
    }
    public static void GuardArm() {
        if (String.IsNullOrEmpty(GuardPath)) throw new InvalidOperationException("AUTOTEST_GUARD_PATH_MISSING");
        if (!String.IsNullOrEmpty(StopPath) && System.IO.File.Exists(StopPath)) Halt("USER_STOP");
        IntPtr hwnd = GetAncestor(GetForegroundWindow(), 2); RECT rect; POINT cursor, origin = new POINT();
        uint pid; GetWindowThreadProcessId(hwnd, out pid);
        GetClientRect(hwnd, out rect); GetCursorPos(out cursor); ClientToScreen(hwnd, ref origin);
        if (hwnd == IntPtr.Zero || pid == 0 || !IsWindowVisible(hwnd) || !GameTitle(WindowTitle(hwnd)) ||
            rect.Right < 100 || rect.Bottom < 100) Halt("CLIENT_UNSAFE");
        WriteGuard(new string[] { hwnd.ToInt64().ToString(), cursor.X.ToString(), cursor.Y.ToString(),
            rect.Right.ToString(), rect.Bottom.ToString(), origin.X.ToString(), origin.Y.ToString(), "0", pid.ToString() });
        System.IO.File.WriteAllText(StopPath + ".armed", "ARMED");
    }
    private static readonly System.Threading.Mutex InputMutex = new System.Threading.Mutex(false, "Local\\MD_AUTOTEST_INPUT_GUARD");
    private const int MouseMovementTolerancePx = 12;
    // Keep the original per-axis rule; tolerate small jitter without changing
    // the scripted target or disabling button/window/foreground protection.
    private static bool CursorOutsideTolerance(int expectedX, int expectedY, int actualX, int actualY) {
        return Math.Abs((long)actualX - expectedX) > MouseMovementTolerancePx ||
            Math.Abs((long)actualY - expectedY) > MouseMovementTolerancePx;
    }
    public static void GuardCheck() {
        if (!InputMutex.WaitOne(5000)) Halt("GUARD_MUTEX_TIMEOUT");
        try { GuardCheckUnlocked(); } finally { InputMutex.ReleaseMutex(); }
    }
    private static void GuardCheckUnlocked() {
        if (String.IsNullOrEmpty(GuardPath)) return;
        if (!String.IsNullOrEmpty(StopPath) && System.IO.File.Exists(StopPath)) Halt("USER_STOP");
        if (!System.IO.File.Exists(GuardPath)) {
            if (System.IO.File.Exists(StopPath + ".armed")) Halt("GUARD_STATE_MISSING");
            return; // One explicit startup activation precedes GuardArm.
        }
        string[] values = System.IO.File.ReadAllText(GuardPath).Split('|');
        if (values.Length != 9) Halt("GUARD_STATE_UNREADABLE");
        long expectedHwnd = 0; uint expectedPid = 0; int number;
        if (!Int64.TryParse(values[0], out expectedHwnd) || !UInt32.TryParse(values[8], out expectedPid) ||
            expectedHwnd == 0 || expectedPid == 0 || (values[7] != "0" && values[7] != "1")) Halt("GUARD_STATE_UNREADABLE");
        for (int i = 1; i <= 6; i++) if (!Int32.TryParse(values[i], out number)) Halt("GUARD_STATE_UNREADABLE");
        IntPtr hwnd = GetForegroundWindow();
        IntPtr root = GetAncestor(hwnd, 2);
        uint foregroundPid, rootPid;
        GetWindowThreadProcessId(hwnd, out foregroundPid); GetWindowThreadProcessId(root, out rootPid);
        string identityReason = ForegroundIdentityReason(expectedHwnd, expectedPid,
            hwnd.ToInt64(), root.ToInt64(), foregroundPid, rootPid, WindowTitle(root), IsWindowVisible(root));
        if (identityReason != null) HaltWithEvidence(identityReason, values, hwnd, root, foregroundPid, rootPid);
        RECT rect; POINT cursor, origin = new POINT();
        GetClientRect(root, out rect); ClientToScreen(root, ref origin); GetCursorPos(out cursor);
        if (rect.Right.ToString() != values[3] || rect.Bottom.ToString() != values[4] ||
            origin.X.ToString() != values[5] || origin.Y.ToString() != values[6])
            HaltWithEvidence("CLIENT_UNSAFE_CHANGED", values, hwnd, root, foregroundPid, rootPid);
        // Scripted movement updates the shared target; physical movement away
        // from it is a test interruption, not a gameplay failure to surrender.
        if (CursorOutsideTolerance(Int32.Parse(values[1]), Int32.Parse(values[2]), cursor.X, cursor.Y))
            HaltWithEvidence("MOUSE_INTERFERENCE", values, hwnd, root, foregroundPid, rootPid);
        if (GetAsyncKeyState(2) < 0 || GetAsyncKeyState(4) < 0 || (GetAsyncKeyState(1) < 0 && values[7] != "1"))
            HaltWithEvidence("MOUSE_INTERFERENCE_BUTTON", values, hwnd, root, foregroundPid, rootPid);
    }
    public static bool SetCursorPos(int x, int y) {
        if (!InputMutex.WaitOne(5000)) Halt("GUARD_MUTEX_TIMEOUT");
        try {
        GuardCheckUnlocked();
        bool result = NativeSetCursorPos(x, y);
        if (!String.IsNullOrEmpty(GuardPath) && System.IO.File.Exists(GuardPath)) {
            string[] values = System.IO.File.ReadAllText(GuardPath).Split('|');
            values[1] = x.ToString(); values[2] = y.ToString(); WriteGuard(values);
        }
        return result;
        } finally { InputMutex.ReleaseMutex(); }
    }
    public static void mouse_event(uint flags, uint dx, uint dy, int data, UIntPtr extra) {
        if (!InputMutex.WaitOne(5000)) Halt("GUARD_MUTEX_TIMEOUT");
        try {
        if (flags == 0x0004) {
            // A failed guard-file update must never strand the physical left
            // button in the down state.  Preserve the error, but release first.
            try {
                if (!String.IsNullOrEmpty(GuardPath) && System.IO.File.Exists(GuardPath)) {
                    string[] values = System.IO.File.ReadAllText(GuardPath).Split('|');
                    values[7] = "0"; WriteGuard(values);
                }
            }
            finally { NativeMouseEvent(flags, dx, dy, data, extra); }
            return;
        }
        GuardCheckUnlocked();
        if (!String.IsNullOrEmpty(GuardPath) && System.IO.File.Exists(GuardPath) && flags == 2) {
            string[] values = System.IO.File.ReadAllText(GuardPath).Split('|');
            values[7] = "1"; WriteGuard(values);
        }
        NativeMouseEvent(flags, dx, dy, data, extra);
        } finally { InputMutex.ReleaseMutex(); }
    }
    public static void keybd_event(byte key, byte scan, uint flags, UIntPtr extra) {
        if (!InputMutex.WaitOne(5000)) Halt("GUARD_MUTEX_TIMEOUT");
        try {
        if ((flags & 2) == 0) GuardCheckUnlocked();
        NativeKeyEvent(key, scan, flags, extra);
        } finally { InputMutex.ReleaseMutex(); }
    }
    public static void GuardRelease() {
        NativeMouseEvent(4, 0, 0, 0, UIntPtr.Zero);
        NativeKeyEvent(0x49, 0, 2, UIntPtr.Zero);
    }
}
"@

# Per-monitor V2 DPI aware. -4 = DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2
try {
    [void][MDWin32]::SetProcessDpiAwarenessContext([IntPtr](-4))
} catch {
    try { [void][MDWin32]::SetProcessDPIAware() } catch {}
}

function Get-MasterDuelInfo {
    [MDWin32]::GuardCheck()
    $hWnd = [MDWin32]::GetAncestor([MDWin32]::GetForegroundWindow(), 2)
    if ($hWnd -eq [IntPtr]::Zero) {
        throw "No foreground window"
    }

    $titleBuilder = New-Object System.Text.StringBuilder 512
    [void][MDWin32]::GetWindowText($hWnd, $titleBuilder, $titleBuilder.Capacity)
    $title = $titleBuilder.ToString()

    if (($title.ToLower().IndexOf("masterduel") -lt 0) -and ($title.ToLower().IndexOf("master duel") -lt 0)) {
        throw ("Foreground window is not Master Duel. Current title: " + $title)
    }

    $wr = New-Object MDWin32+RECT
    $cr = New-Object MDWin32+RECT
    [void][MDWin32]::GetWindowRect($hWnd, [ref]$wr)
    [void][MDWin32]::GetClientRect($hWnd, [ref]$cr)

    $origin = New-Object MDWin32+POINT
    $origin.X = 0
    $origin.Y = 0
    [void][MDWin32]::ClientToScreen($hWnd, [ref]$origin)

    $desktopW = [MDWin32]::GetSystemMetrics(0)
    $desktopH = [MDWin32]::GetSystemMetrics(1)
    $verifiedPid = 0
    [void][MDWin32]::GetWindowThreadProcessId($hWnd, [ref]$verifiedPid)

    return [PSCustomObject]@{
        title = $title
        hwnd = $hWnd.ToInt64()
        pid = $verifiedPid
        desktop = [PSCustomObject]@{
            width = $desktopW
            height = $desktopH
        }
        window = [PSCustomObject]@{
            x = $wr.Left
            y = $wr.Top
            width = $wr.Right - $wr.Left
            height = $wr.Bottom - $wr.Top
        }
        client = [PSCustomObject]@{
            x = $origin.X
            y = $origin.Y
            width = $cr.Right - $cr.Left
            height = $cr.Bottom - $cr.Top
        }
    }
}

function Activate-MasterDuelWindow {
    if ($env:MD_AUTOTEST_GUARD -and ([System.IO.File]::Exists($env:MD_AUTOTEST_GUARD) -or [System.IO.File]::Exists($env:MD_AUTOTEST_STOP + '.armed'))) {
        [MDWin32]::GuardCheck()
        return Get-MasterDuelInfo
    }
    $matched = $null
    $holder = New-Object object[] 1
    $callback = [MDWin32+EnumWindowsProc]{
        param([IntPtr]$hWnd, [IntPtr]$lParam)
        if (-not [MDWin32]::IsWindowVisible($hWnd)) { return $true }
        $builder = New-Object System.Text.StringBuilder 512
        [void][MDWin32]::GetWindowText($hWnd, $builder, $builder.Capacity)
        $candidate = $builder.ToString().ToLowerInvariant()
        # Prefer the real game window title. Unity/YgoMaster helper windows can
        # contain the install path "Master Duel" but have a different client
        # size and must not receive gameplay coordinates.
        if ($candidate -eq 'masterduel' -or $candidate -eq 'master duel') {
            $holder[0] = $hWnd
            return $false
        }
        if (($candidate.Contains('masterduel') -or $candidate.Contains('master duel')) -and $null -eq $holder[0]) {
            $holder[0] = $hWnd
        }
        return $true
    }
    [void][MDWin32]::EnumWindows($callback, [IntPtr]::Zero)
    $matched = $holder[0]

    # Some fullscreen/compatibility layers expose the game only as the
    # foreground window to a child process, while EnumWindows returns none.
    # Use this bounded fallback only when the foreground title is unambiguously
    # Master Duel; never click an unknown foreground application.
    if ($null -eq $matched -or $matched -eq [IntPtr]::Zero) {
        $foreground = [MDWin32]::GetForegroundWindow()
        if ($foreground -ne [IntPtr]::Zero) {
            $builder = New-Object System.Text.StringBuilder 512
            [void][MDWin32]::GetWindowText($foreground, $builder, $builder.Capacity)
            $foregroundTitle = $builder.ToString().ToLowerInvariant()
            if ($foregroundTitle.Contains('masterduel') -or $foregroundTitle.Contains('master duel')) {
                $matched = $foreground
            }
        }
    }

    if ($null -eq $matched -or $matched -eq [IntPtr]::Zero) {
        throw "Master Duel window was not found"
    }

    [void][MDWin32]::ShowWindow($matched, 9)
    $shell = New-Object -ComObject WScript.Shell
    $windowPid = 0
    $targetThread = [MDWin32]::GetWindowThreadProcessId($matched, [ref]$windowPid)
    if ($windowPid -gt 0) { [void]$shell.AppActivate($windowPid) }
    Start-Sleep -Milliseconds 500
    $foreground = [MDWin32]::GetForegroundWindow()
    $foregroundPid = 0
    $foregroundThread = if ($foreground -ne [IntPtr]::Zero) {
        [MDWin32]::GetWindowThreadProcessId($foreground, [ref]$foregroundPid)
    } else { 0 }
    $attached = $false
    if ($foregroundThread -gt 0 -and $targetThread -gt 0 -and $foregroundThread -ne $targetThread) {
        $attached = [MDWin32]::AttachThreadInput($foregroundThread, $targetThread, $true)
    }
    [void][MDWin32]::SetForegroundWindow($matched)
    if ($attached) { [void][MDWin32]::AttachThreadInput($foregroundThread, $targetThread, $false) }
    Start-Sleep -Milliseconds 350
    return Get-MasterDuelInfo
}
