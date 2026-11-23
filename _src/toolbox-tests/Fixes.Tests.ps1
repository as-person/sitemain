# Pester 3.4 tests for the final-review fixes.
# Run: powershell -NoProfile -Command "Invoke-Pester _src/toolbox-tests/Fixes.Tests.ps1"
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$scriptPath = Join-Path $root 'toolbox\somov-toolbox.ps1'
. $scriptPath
$feed = Get-Content (Join-Path $root 'toolbox\items.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$item = { param($id) $feed.items | Where-Object id -eq $id }

Describe 'TLS 1.2 is on (Windows 10 PowerShell 5.1 may default to SSL3/TLS 1.0)' {
  It 'enables Tls12' { ([Net.ServicePointManager]::SecurityProtocol -band [Net.SecurityProtocolType]::Tls12) | Should Be ([Net.SecurityProtocolType]::Tls12) }
}

Describe 'installer exit codes' {
  It 'a script that exits 1 is reported as failed' {
    Mock Save-ToolboxFile { $Dest }
    Mock Start-Process { [pscustomobject]@{ ExitCode = 1 } }
    $i = [pscustomobject]@{ id = 'x'; kind = 'script'; title = @{ ru = 'x' } }
    (Invoke-ToolboxItem -Item $i -File ([pscustomobject]@{ url = 'https://dl3.somov.org/x.bat'; name = 'x.bat' }) -Log { }).Ok | Should Be $false
  }
  It 'an exe that asks for a reboot (3010) is a success' {
    Mock Save-ToolboxFile { $Dest }
    Mock Start-Process { [pscustomobject]@{ ExitCode = 3010 } }
    $i = [pscustomobject]@{ id = 'x'; kind = 'exe' }
    (Invoke-ToolboxItem -Item $i -File ([pscustomobject]@{ url = 'https://dl3.somov.org/x.exe'; name = 'x.exe' }) -Log { }).Ok | Should Be $true
  }
  It 'a failing install_all.bat is reported as failed' {
    Mock Save-ToolboxFile { $Dest }
    Mock Expand-Archive { }
    Mock Start-Process { [pscustomobject]@{ ExitCode = 5 } }
    $vc = & $item 'vcpp-runtimes'
    (Invoke-ToolboxItem -Item $vc -File $vc.files[0] -Log { }).Ok | Should Be $false
  }
}

Describe 'cmd quoting survives ( ) & in paths' {
  It 'wraps the whole command in an extra pair of quotes' {
    Mock Save-ToolboxFile { 'C:\Users\Ivan (Work)\AppData\Local\Temp\somov-toolbox\x.bat' }
    Mock Start-Process { [pscustomobject]@{ ExitCode = 0 } }
    $i = [pscustomobject]@{ id = 'x'; kind = 'script' }
    Invoke-ToolboxItem -Item $i -File ([pscustomobject]@{ url = 'https://dl3.somov.org/x.bat'; name = 'x.bat' }) -Log { } | Out-Null
    Assert-MockCalled Start-Process -Scope It -ParameterFilter { "$ArgumentList" -eq '/c ""C:\Users\Ivan (Work)\AppData\Local\Temp\somov-toolbox\x.bat""' }
  }
}

Describe 'PowerShell commands with spaces in folder names' {
  It 'passes the code as -EncodedCommand so quotes and Cyrillic survive' {
    Mock Start-Process { $script:args_ = $ArgumentList; [pscustomobject]@{ ExitCode = 0 } }
    Invoke-ToolboxPowerShell 'Export-WindowsDriver -Online -Destination "D:\Мои драйверы"' | Out-Null
    $list = @($script:args_)
    $i = [array]::IndexOf($list, '-EncodedCommand')
    $i | Should BeGreaterThan -1
    [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($list[$i + 1])) | Should Match 'D:\\Мои драйверы'
  }
  It 'a command that fails is reported as failed' {
    Mock Start-Process { [pscustomobject]@{ ExitCode = 1 } }
    Invoke-ToolboxPowerShell 'throw 1' | Should Be $false
  }
}

Describe 'links open in the normal (not elevated) browser' {
  It 'opens a page through explorer.exe' {
    Mock Start-Process { }
    Open-ToolboxUrl 'https://somov.org/tweaks/defrag-tools'
    Assert-MockCalled Start-Process -Scope It -ParameterFilter { $FilePath -eq 'explorer.exe' -and "$ArgumentList" -like '*somov.org/tweaks/defrag-tools*' }
  }
}

Describe 'the apply job always finishes' {
  It 'a broken script path still reports an error and the done marker' {
    $q = [System.Collections.Concurrent.ConcurrentQueue[string]]::new()
    Invoke-ToolboxApplyJob -ScriptPath 'C:\no\such\script.ps1' -Selections @() -Queue $q -Lang 'ru'
    $lines = @(); $line = $null; while ($q.TryDequeue([ref]$line)) { $lines += $line }
    ($lines | Where-Object { $_ -like '✗*' }) | Should Not BeNullOrEmpty
    $lines[-1] | Should Match '^::done::'
  }
}

Describe 'the apply job in a real runspace (as Start-ToolboxApply runs it)' {
  It 'loads the script from its text and reports done' {
    $q = [System.Collections.Concurrent.ConcurrentQueue[string]]::new()
    $rs = [runspacefactory]::CreateRunspace(); $rs.ApartmentState = 'STA'; $rs.Open()
    $ps = [powershell]::Create(); $ps.Runspace = $rs
    [void]$ps.AddScript(${function:Invoke-ToolboxApplyJob}.ToString()).AddArgument($scriptPath).AddArgument(@()).AddArgument($q).AddArgument('ru')
    $ps.Invoke() | Out-Null
    $lines = @(); $line = $null; while ($q.TryDequeue([ref]$line)) { $lines += $line }
    $ps.Dispose(); $rs.Dispose()
    ($lines -join ' | ') | Should Be '::done::0::0'
  }
}