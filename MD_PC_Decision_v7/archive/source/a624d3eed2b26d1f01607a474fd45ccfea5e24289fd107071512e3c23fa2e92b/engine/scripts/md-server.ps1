# Master Duel v5 persistent Windows bridge.
# One PowerShell process stays alive and accepts newline-delimited JSON commands from Node.js.

. "$PSScriptRoot\md-common.ps1"
Add-Type -AssemblyName System.Drawing

$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

function Write-JsonResponse {
    param([object]$Object)
    $json = $Object | ConvertTo-Json -Compress -Depth 8
    [Console]::Out.WriteLine($json)
    [Console]::Out.Flush()
}

function Write-JsonError {
    param([string]$Message)
    $guardFailure = $null
    if ($env:MD_AUTOTEST_GUARD -and [System.IO.File]::Exists($env:MD_AUTOTEST_GUARD + '.failure.json')) {
        try { $guardFailure = [System.IO.File]::ReadAllText($env:MD_AUTOTEST_GUARD + '.failure.json') | ConvertFrom-Json } catch { }
    }
    Write-JsonResponse ([PSCustomObject]@{
        ok = $false
        error = $Message
        code = if ($guardFailure) { $guardFailure.reason } else { $null }
        guardFailure = $guardFailure
    })
}

function Save-ClientScreenshot {
    param(
        [object]$Info,
        [string]$OutputPath
    )

    $c = $Info.client
    if ($c.width -le 0 -or $c.height -le 0) {
        throw 'Invalid Master Duel client size'
    }

    $dir = [System.IO.Path]::GetDirectoryName($OutputPath)
    if ($dir -and -not [System.IO.Directory]::Exists($dir)) {
        [System.IO.Directory]::CreateDirectory($dir) | Out-Null
    }

    $bmp = New-Object System.Drawing.Bitmap(
        $c.width,
        $c.height,
        [System.Drawing.Imaging.PixelFormat]::Format32bppArgb
    )

    $g = [System.Drawing.Graphics]::FromImage($bmp)
    try {
        $g.CopyFromScreen(
            $c.x,
            $c.y,
            0,
            0,
            (New-Object System.Drawing.Size($c.width, $c.height)),
            [System.Drawing.CopyPixelOperation]::SourceCopy
        )
        $bmp.Save($OutputPath, [System.Drawing.Imaging.ImageFormat]::Png)
    }
    finally {
        $g.Dispose()
        $bmp.Dispose()
    }
}

function Capture-ClientRoiBase64 {
    param(
        [object]$Info,
        [int]$X,
        [int]$Y,
        [int]$Width,
        [int]$Height
    )

    $c = $Info.client

    if ($X -lt 0 -or $Y -lt 0 -or $Width -le 0 -or $Height -le 0 -or
        ($X + $Width) -gt $c.width -or ($Y + $Height) -gt $c.height) {
        throw "ROI outside Master Duel client: x=$X y=$Y w=$Width h=$Height client=$($c.width)x$($c.height)"
    }

    $bmp = New-Object System.Drawing.Bitmap(
        $Width,
        $Height,
        [System.Drawing.Imaging.PixelFormat]::Format32bppArgb
    )

    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $ms = New-Object System.IO.MemoryStream
    try {
        $g.CopyFromScreen(
            $c.x + $X,
            $c.y + $Y,
            0,
            0,
            (New-Object System.Drawing.Size($Width, $Height)),
            [System.Drawing.CopyPixelOperation]::SourceCopy
        )

        $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
        return [Convert]::ToBase64String($ms.ToArray())
    }
    finally {
        $g.Dispose()
        $bmp.Dispose()
        $ms.Dispose()
    }
}

function Capture-DesktopBase64 {
    # Capture the full virtual desktop. Using the virtual origin avoids an
    # invalid CopyFromScreen source rectangle on windowed/multi-monitor setups.
    $originX = [MDWin32]::GetSystemMetrics(76)
    $originY = [MDWin32]::GetSystemMetrics(77)
    $width = [MDWin32]::GetSystemMetrics(78)
    $height = [MDWin32]::GetSystemMetrics(79)
    if ($width -le 0 -or $height -le 0) {
        $originX = 0
        $originY = 0
        $width = [MDWin32]::GetSystemMetrics(0)
        $height = [MDWin32]::GetSystemMetrics(1)
    }
    $bmp = New-Object System.Drawing.Bitmap(
        $width,
        $height,
        [System.Drawing.Imaging.PixelFormat]::Format32bppArgb
    )
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $ms = New-Object System.IO.MemoryStream
    try {
        $g.CopyFromScreen(
            $originX,
            $originY,
            0,
            0,
            (New-Object System.Drawing.Size($width, $height)),
            [System.Drawing.CopyPixelOperation]::SourceCopy
        )
        $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
        return [PSCustomObject]@{
            width = $width
            height = $height
            pngBase64 = [Convert]::ToBase64String($ms.ToArray())
        }
    }
    finally {
        $g.Dispose()
        $bmp.Dispose()
        $ms.Dispose()
    }
}

function Click-ClientPoint {
    param(
        [object]$Info,
        [int]$X,
        [int]$Y
    )

    $c = $Info.client

    if ($X -lt 0 -or $Y -lt 0 -or $X -ge $c.width -or $Y -ge $c.height) {
        throw "Click outside Master Duel client: x=$X y=$Y client=$($c.width)x$($c.height)"
    }

    $screenX = $c.x + $X
    $screenY = $c.y + $Y

    [void][MDWin32]::SetCursorPos($screenX, $screenY)
    Start-Sleep -Milliseconds 5
    [MDWin32]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 5
    [MDWin32]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)

    return [PSCustomObject]@{
        clientX = $X
        clientY = $Y
        screenX = $screenX
        screenY = $screenY
    }
}

function Move-ClientPoint {
    param(
        [object]$Info,
        [int]$X,
        [int]$Y
    )

    $c = $Info.client
    if ($X -lt 0 -or $Y -lt 0 -or $X -ge $c.width -or $Y -ge $c.height) {
        throw "Mouse move outside Master Duel client: x=$X y=$Y client=$($c.width)x$($c.height)"
    }

    $screenX = $c.x + $X
    $screenY = $c.y + $Y
    [void][MDWin32]::SetCursorPos($screenX, $screenY)
    return [PSCustomObject]@{
        clientX = $X
        clientY = $Y
        screenX = $screenX
        screenY = $screenY
    }
}

function MouseDown-ClientPoint {
    param(
        [object]$Info,
        [int]$X,
        [int]$Y
    )

    $point = Move-ClientPoint -Info $Info -X $X -Y $Y
    [MDWin32]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
    return $point
}

function MouseUp-LeftButton {
    [MDWin32]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
}

function Drag-ClientPoint {
    param(
        [object]$Info,
        [int]$X1,
        [int]$Y1,
        [int]$X2,
        [int]$Y2,
        [int]$DurationMs = 180,
        [int]$Steps = 12
    )

    $c = $Info.client
    foreach ($point in @(@($X1, $Y1), @($X2, $Y2))) {
        if ($point[0] -lt 0 -or $point[1] -lt 0 -or $point[0] -ge $c.width -or $point[1] -ge $c.height) {
            throw "Drag outside Master Duel client: ($($point[0]),$($point[1])) client=$($c.width)x$($c.height)"
        }
    }

    $stepsSafe = [Math]::Max(2, [Math]::Min(60, $Steps))
    $durationSafe = [Math]::Max(40, [Math]::Min(1500, $DurationMs))
    $interval = [Math]::Max(1, [Math]::Floor($durationSafe / $stepsSafe))
    $start = Move-ClientPoint -Info $Info -X $X1 -Y $Y1
    Start-Sleep -Milliseconds 12
    [MDWin32]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)

    try {
        for ($i = 1; $i -le $stepsSafe; $i++) {
            $t = $i / [double]$stepsSafe
            $x = [Math]::Round($X1 + ($X2 - $X1) * $t)
            $y = [Math]::Round($Y1 + ($Y2 - $Y1) * $t)
            [void][MDWin32]::SetCursorPos($c.x + $x, $c.y + $y)
            Start-Sleep -Milliseconds $interval
        }
    }
    finally {
        [MDWin32]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
    }

    return [PSCustomObject]@{
        startClientX = $X1
        startClientY = $Y1
        endClientX = $X2
        endClientY = $Y2
        startScreenX = $start.screenX
        startScreenY = $start.screenY
        endScreenX = $c.x + $X2
        endScreenY = $c.y + $Y2
        durationMs = $durationSafe
        steps = $stepsSafe
    }
}

function Wheel-ClientPoint {
    param(
        [object]$Info,
        [int]$X,
        [int]$Y,
        [int]$Delta
    )

    $c = $Info.client

    if ($X -lt 0 -or $Y -lt 0 -or $X -ge $c.width -or $Y -ge $c.height) {
        throw "Wheel outside Master Duel client: x=$X y=$Y client=$($c.width)x$($c.height)"
    }

    $screenX = $c.x + $X
    $screenY = $c.y + $Y

    [void][MDWin32]::SetCursorPos($screenX, $screenY)
    Start-Sleep -Milliseconds 20
    [MDWin32]::mouse_event(0x0800, 0, 0, $Delta, [UIntPtr]::Zero)

    return [PSCustomObject]@{
        clientX = $X
        clientY = $Y
        delta = $Delta
        screenX = $screenX
        screenY = $screenY
    }
}

function WheelBurst-ClientPoint {
    param(
        [object]$Info,
        [int]$X,
        [int]$Y,
        [int]$Delta,
        [int]$Count,
        [int]$IntervalMs
    )

    $c = $Info.client

    if ($X -lt 0 -or $Y -lt 0 -or $X -ge $c.width -or $Y -ge $c.height) {
        throw "WheelBurst outside Master Duel client: x=$X y=$Y client=$($c.width)x$($c.height)"
    }

    $Count = [Math]::Max(1, [Math]::Min(200, $Count))
    $IntervalMs = [Math]::Max(0, [Math]::Min(50, $IntervalMs))
    $screenX = $c.x + $X
    $screenY = $c.y + $Y

    [void][MDWin32]::SetCursorPos($screenX, $screenY)
    Start-Sleep -Milliseconds 20
    for ($i = 0; $i -lt $Count; $i++) {
        [MDWin32]::mouse_event(0x0800, 0, 0, $Delta, [UIntPtr]::Zero)
        if ($IntervalMs -gt 0 -and $i -lt ($Count - 1)) {
            Start-Sleep -Milliseconds $IntervalMs
        }
    }

    return [PSCustomObject]@{
        clientX = $X
        clientY = $Y
        delta = $Delta
        count = $Count
        intervalMs = $IntervalMs
        screenX = $screenX
        screenY = $screenY
    }
}

function Click-ScreenPoint {
    param(
        [int]$X,
        [int]$Y
    )

    $desktopW = [MDWin32]::GetSystemMetrics(0)
    $desktopH = [MDWin32]::GetSystemMetrics(1)
    if ($X -lt 0 -or $Y -lt 0 -or $X -ge $desktopW -or $Y -ge $desktopH) {
        throw "Screen click outside desktop: x=$X y=$Y desktop=$($desktopW)x$($desktopH)"
    }

    [void][MDWin32]::SetCursorPos($X, $Y)
    Start-Sleep -Milliseconds 20
    [MDWin32]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 10
    [MDWin32]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
    return [PSCustomObject]@{ screenX = $X; screenY = $Y }
}


function Press-Key {
    param([string]$Key)

    $vk = 0
    switch ($Key.ToUpperInvariant()) {
        'ESC' { $vk = 0x1B }
        default { throw "Unsupported key: $Key" }
    }

    [MDWin32]::keybd_event([byte]$vk, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 8
    [MDWin32]::keybd_event([byte]$vk, 0, 0x0002, [UIntPtr]::Zero)

    return [PSCustomObject]@{ key = $Key }
}

# Tell Node the bridge is ready.
Write-JsonResponse ([PSCustomObject]@{
    ok = $true
    event = 'ready'
    pid = $PID
})

while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    if ([string]::IsNullOrWhiteSpace($line)) { continue }

    try {
        $req = $line | ConvertFrom-Json
        $cmd = [string]$req.cmd
        [MDWin32]::SetGuardOperation($cmd)

        if ($cmd -eq 'quit') {
            Write-JsonResponse ([PSCustomObject]@{ ok = $true; event = 'bye' })
            break
        }

        if ($cmd -eq 'guardRelease') {
            [MDWin32]::GuardRelease()
            Write-JsonResponse ([PSCustomObject]@{ ok = $true; released = $true })
            continue
        }
        if ($cmd -eq 'guardArm') {
            $info = Get-MasterDuelInfo
            [MDWin32]::GuardArm()
            Write-JsonResponse ([PSCustomObject]@{ ok = $true; armed = $true })
            continue
        }
        if ($cmd -eq 'guardCheck') {
            [MDWin32]::GuardCheck()
            Write-JsonResponse ([PSCustomObject]@{ ok = $true; safe = $true })
            continue
        }

        if ($cmd -eq 'activateMasterDuel') {
            $info = Activate-MasterDuelWindow
            Write-JsonResponse ([PSCustomObject]@{
                ok = $true
                title = $info.title
                hwnd = $info.hwnd
                pid = $info.pid
                desktop = $info.desktop
                window = $info.window
                client = $info.client
            })
            continue
        }

        if ($cmd -eq 'clickScreen') {
            $click = Click-ScreenPoint -X ([int]$req.x) -Y ([int]$req.y)
            Write-JsonResponse ([PSCustomObject]@{
                ok = $true
                screenX = $click.screenX
                screenY = $click.screenY
            })
            continue
        }

        if ($cmd -eq 'captureDesktop') {
            $capture = Capture-DesktopBase64
            Write-JsonResponse ([PSCustomObject]@{
                ok = $true
                width = $capture.width
                height = $capture.height
                pngBase64 = $capture.pngBase64
            })
            continue
        }

        # Release must not depend on Master Duel still being foreground. This
        # command is the fail-safe used after any capture or recognition error.
        if ($cmd -eq 'mouseUp') {
            MouseUp-LeftButton
            Write-JsonResponse ([PSCustomObject]@{ ok = $true; released = $true })
            continue
        }

        $info = Get-MasterDuelInfo

        switch ($cmd) {
            'info' {
                Write-JsonResponse ([PSCustomObject]@{
                    ok = $true
                    title = $info.title
                    hwnd = $info.hwnd
                    pid = $info.pid
                    desktop = $info.desktop
                    window = $info.window
                    client = $info.client
                })
            }

            'saveClient' {
                $outputPath = [string]$req.outputPath
                Save-ClientScreenshot -Info $info -OutputPath $outputPath
                Write-JsonResponse ([PSCustomObject]@{
                    ok = $true
                    title = $info.title
                    desktop = $info.desktop
                    window = $info.window
                    client = $info.client
                    output = $outputPath
                })
            }

            'captureRoi' {
                $x = [int]$req.x
                $y = [int]$req.y
                $w = [int]$req.width
                $h = [int]$req.height
                $png64 = Capture-ClientRoiBase64 -Info $info -X $x -Y $y -Width $w -Height $h
                # Do not return/cache a desktop frame contaminated by a focus
                # change during CopyFromScreen. No extra capture or wait.
                [MDWin32]::GuardCheck()

                Write-JsonResponse ([PSCustomObject]@{
                    ok = $true
                    title = $info.title
                    client = $info.client
                    hwnd = $info.hwnd
                    pid = $info.pid
                    capturedAt = [DateTime]::UtcNow.ToString('o')
                    guardedCapture = $true
                    x = $x
                    y = $y
                    width = $w
                    height = $h
                    pngBase64 = $png64
                })
            }

            'click' {
                $x = [int]$req.x
                $y = [int]$req.y
                $click = Click-ClientPoint -Info $info -X $x -Y $y

                Write-JsonResponse ([PSCustomObject]@{
                    ok = $true
                    title = $info.title
                    client = $info.client
                    clientX = $click.clientX
                    clientY = $click.clientY
                    screenX = $click.screenX
                    screenY = $click.screenY
                })
            }

            'move' {
                $x = [int]$req.x
                $y = [int]$req.y
                $point = Move-ClientPoint -Info $info -X $x -Y $y
                Write-JsonResponse ([PSCustomObject]@{
                    ok = $true
                    title = $info.title
                    client = $info.client
                    clientX = $point.clientX
                    clientY = $point.clientY
                    screenX = $point.screenX
                    screenY = $point.screenY
                })
            }

            'mouseDown' {
                $x = [int]$req.x
                $y = [int]$req.y
                $point = MouseDown-ClientPoint -Info $info -X $x -Y $y
                Write-JsonResponse ([PSCustomObject]@{
                    ok = $true
                    title = $info.title
                    client = $info.client
                    clientX = $point.clientX
                    clientY = $point.clientY
                    screenX = $point.screenX
                    screenY = $point.screenY
                    pressed = $true
                })
            }

            'drag' {
                $x1 = [int]$req.x1
                $y1 = [int]$req.y1
                $x2 = [int]$req.x2
                $y2 = [int]$req.y2
                $durationMs = if ($null -ne $req.durationMs) { [int]$req.durationMs } else { 180 }
                $steps = if ($null -ne $req.steps) { [int]$req.steps } else { 12 }
                $drag = Drag-ClientPoint -Info $info -X1 $x1 -Y1 $y1 -X2 $x2 -Y2 $y2 -DurationMs $durationMs -Steps $steps
                Write-JsonResponse ([PSCustomObject]@{
                    ok = $true
                    title = $info.title
                    client = $info.client
                    drag = $drag
                })
            }

            'wheel' {
                $x = [int]$req.x
                $y = [int]$req.y
                $delta = [int]$req.delta
                $wheel = Wheel-ClientPoint -Info $info -X $x -Y $y -Delta $delta

                Write-JsonResponse ([PSCustomObject]@{
                    ok = $true
                    title = $info.title
                    client = $info.client
                    clientX = $wheel.clientX
                    clientY = $wheel.clientY
                    delta = $wheel.delta
                    screenX = $wheel.screenX
                    screenY = $wheel.screenY
                })
            }

            'wheelBurst' {
                $x = [int]$req.x
                $y = [int]$req.y
                $delta = [int]$req.delta
                $count = [int]$req.count
                $intervalMs = [int]$req.intervalMs
                $wheel = WheelBurst-ClientPoint -Info $info -X $x -Y $y -Delta $delta -Count $count -IntervalMs $intervalMs

                Write-JsonResponse ([PSCustomObject]@{
                    ok = $true
                    title = $info.title
                    client = $info.client
                    clientX = $wheel.clientX
                    clientY = $wheel.clientY
                    delta = $wheel.delta
                    count = $wheel.count
                    intervalMs = $wheel.intervalMs
                    screenX = $wheel.screenX
                    screenY = $wheel.screenY
                })
            }

            'wheelBurstCaptureReferenceRoi' {
                $referenceWidth = [Math]::Max(1, [int]$req.referenceWidth)
                $referenceHeight = [Math]::Max(1, [int]$req.referenceHeight)
                $scaleX = $info.client.width / [double]$referenceWidth
                $scaleY = $info.client.height / [double]$referenceHeight

                $x = [Math]::Round(([double]$req.refX) * $scaleX)
                $y = [Math]::Round(([double]$req.refY) * $scaleY)
                $delta = [int]$req.delta
                $count = [int]$req.count
                $intervalMs = [int]$req.intervalMs
                $settleMs = [Math]::Max(0, [Math]::Min(1000, [int]$req.settleMs))

                $roiX = [Math]::Round(([double]$req.roiX) * $scaleX)
                $roiY = [Math]::Round(([double]$req.roiY) * $scaleY)
                $roiW = [Math]::Max(1, [Math]::Round(([double]$req.roiWidth) * $scaleX))
                $roiH = [Math]::Max(1, [Math]::Round(([double]$req.roiHeight) * $scaleY))

                $wheel = WheelBurst-ClientPoint -Info $info -X $x -Y $y -Delta $delta -Count $count -IntervalMs $intervalMs
                if ($settleMs -gt 0) { Start-Sleep -Milliseconds $settleMs }
                $png64 = Capture-ClientRoiBase64 -Info $info -X $roiX -Y $roiY -Width $roiW -Height $roiH

                Write-JsonResponse ([PSCustomObject]@{
                    ok = $true
                    title = $info.title
                    desktop = $info.desktop
                    window = $info.window
                    client = $info.client
                    wheel = $wheel
                    pngBase64 = $png64
                })
            }

            'key' {
                $key = [string]$req.key
                $r = Press-Key -Key $key
                Write-JsonResponse ([PSCustomObject]@{
                    ok = $true
                    title = $info.title
                    key = $r.key
                })
            }

            default {
                throw "Unknown command: $cmd"
            }
        }
    }
    catch {
        Write-JsonError $_.Exception.Message
    }
}
