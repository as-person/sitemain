# Pester 3.4 tests for running toolbox items.
# Run: powershell -NoProfile -Command "Invoke-Pester _src/toolbox-tests/Run.Tests.ps1"
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
. (Join-Path $root 'toolbox\somov-toolbox.ps1')
$feed = Get-Content (Join-Path $root 'toolbox\items.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$item = { param($id) $feed.items | Where-Object id -eq $id }

Describe 'Save-ToolboxFile' {
  It 'refuses hosts other than somov.org and dl3.somov.org' {
    { Save-ToolboxFile -Url 'https://evil.example/x.exe' -Dest (Join-Path $env:TEMP 'x.exe') } | Should Throw
  }
  It 'downloads from dl3 with the toolbox User-Agent' {
    Mock Invoke-WebRequest { }
    Save-ToolboxFile -Url 'https://dl3.somov.org/notepad.reg' -Dest (Join-Path $env:TEMP 'notepad.reg') | Out-Null
    Assert-MockCalled Invoke-WebRequest -Times 1 -ParameterFilter { $UserAgent -like 'somov-toolbox/*' -and $Uri -eq 'https://dl3.somov.org/notepad.reg' }
  }
}

Describe 'Invoke-ToolboxBatch' {
  It 'one failing item does not stop the others' {
    Mock Invoke-ToolboxItem {
      if ($Item.id -eq 'two') { throw 'boom' }
      @{ Ok = $true; Message = 'ok' }
    }
    $sel = @(
      @{ Item = [pscustomobject]@{ id = 'one' }; File = $null },
      @{ Item = [pscustomobject]@{ id = 'two' }; File = $null },
      @{ Item = [pscustomobject]@{ id = 'three' }; File = $null }
    )
    $r = Invoke-ToolboxBatch -Selections $sel -Log { }
    $r.Done | Should Be 2
    @($r.Failed) -join ',' | Should Be 'two'
  }
}

Describe 'Invoke-ToolboxItem' {
  It 'an archive with a run file runs it after extracting (VC++)' {
    Mock Save-ToolboxFile { $Dest }
    Mock Expand-Archive { }
    Mock Start-Process { [pscustomobject]@{ ExitCode = 0 } }
    $vc = & $item 'vcpp-runtimes'
    $r = Invoke-ToolboxItem -Item $vc -File $vc.files[0] -Log { }
    $r.Ok | Should Be $true
    Assert-MockCalled Start-Process -ParameterFilter { "$ArgumentList" -like '*install_all.bat*' }
  }
  It 'a failed Defender Remover download shows the hint and opens Windows Security' {
    Mock Save-ToolboxFile { throw 'blocked' }
    Mock Start-Process { }
    $d = & $item 'defender-remover'
    $r = Invoke-ToolboxItem -Item $d -File $d.files[0] -Log { }
    $r.Ok | Should Be $false
    $r.Message | Should Match 'Tamper|подделки'
    Assert-MockCalled Start-Process -ParameterFilter { $FilePath -eq 'windowsdefender://threatsettings' }
  }
  It 'driver backup goes to the folder the user picked' {
    Mock Select-ToolboxFolder { 'E:\drv' }
    Mock Invoke-ToolboxPowerShell { $script:ran = $Code }
    $b = & $item 'backup-drivers'
    Invoke-ToolboxItem -Item $b -File $b.commands[0] -Log { } | Out-Null
    $script:ran | Should Match '-Destination "E:\\drv"'
  }
  It 'a cancelled folder picker runs nothing' {
    Mock Select-ToolboxFolder { $null }
    Mock Invoke-ToolboxPowerShell { }
    $b = & $item 'backup-drivers'
    $r = Invoke-ToolboxItem -Item $b -File $b.commands[0] -Log { }
    $r.Ok | Should Be $false
    Assert-MockCalled Invoke-ToolboxPowerShell -Times 0 -Exactly -Scope It
  }
  It 'a reg item is imported silently' {
    Mock Save-ToolboxFile { $Dest }
    Mock Start-Process { [pscustomobject]@{ ExitCode = 0 } }
    $n = & $item 'classic-notepad'
    (Invoke-ToolboxItem -Item $n -File $n.files[0] -Log { }).Ok | Should Be $true
    Assert-MockCalled Start-Process -ParameterFilter { $FilePath -eq 'reg.exe' -and "$ArgumentList" -like 'import*' }
  }
}
