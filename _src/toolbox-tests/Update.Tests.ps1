# Pester 3.4 tests for self-update and installing a downloaded copy.
# Run: powershell -NoProfile -Command "Invoke-Pester _src/toolbox-tests/Update.Tests.ps1"
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
. (Join-Path $root 'toolbox\somov-toolbox.ps1')

Describe 'Test-FileHash' {
  $f = Join-Path $env:TEMP 'somov-hash-test.txt'
  Set-Content $f 'abc' -NoNewline -Encoding ASCII
  It 'matches the right SHA-256' { Test-FileHash $f 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad' | Should Be $true }
  It 'rejects a wrong one' { Test-FileHash $f ('0' * 64) | Should Be $false }
}

Describe 'Update-Toolbox' {
  $target = Join-Path $env:TEMP 'somov-update-target.ps1'
  It 'a newer version with a wrong hash is not installed' {
    Set-Content $target 'old' -Encoding ASCII
    Mock Invoke-RestMethod { [pscustomobject]@{ version = '9.9.9'; sha256 = ('0' * 64) } }
    Mock Save-ToolboxFile { New-Item -ItemType Directory -Force (Split-Path -Parent $Dest) | Out-Null; Set-Content $Dest 'new' -Encoding ASCII; $Dest }
    Update-Toolbox -Target $target | Should Be $false
    (Get-Content $target) | Should Be 'old'
  }
  It 'a newer version with the right hash replaces the script' {
    Set-Content $target 'old' -Encoding ASCII
    $tmp = Join-Path $env:TEMP 'somov-new.ps1'; Set-Content $tmp 'new' -Encoding ASCII
    $hash = (Get-FileHash $tmp -Algorithm SHA256).Hash.ToLower()
    Mock Invoke-RestMethod { [pscustomobject]@{ version = '9.9.9'; sha256 = $hash } }
    Mock Save-ToolboxFile { New-Item -ItemType Directory -Force (Split-Path -Parent $Dest) | Out-Null; Set-Content $Dest 'new' -Encoding ASCII; $Dest }
    Update-Toolbox -Target $target | Should Be $true
    (Get-Content $target) | Should Be 'new'
  }
  It 'the same version does nothing' {
    Mock Invoke-RestMethod { [pscustomobject]@{ version = $ToolboxVersion; sha256 = 'x' } }
    Mock Save-ToolboxFile { }
    Update-Toolbox -Target $target | Should Be $false
    Assert-MockCalled Save-ToolboxFile -Times 0 -Exactly -Scope It
  }
  It 'no internet does nothing and does not throw' {
    Mock Invoke-RestMethod { throw 'offline' }
    { Update-Toolbox -Target $target } | Should Not Throw
  }
}

Describe 'Install-ToolboxCopy' {
  It 'a copy run from elsewhere installs itself into ProgramData with a shortcut' {
    Mock Copy-Item { }
    Mock New-Item { }
    Mock New-ToolboxShortcut { }
    $r = Install-ToolboxCopy -From 'C:\Temp\x' -To 'C:\ProgramData\somov\Toolbox'
    $r | Should Be 'C:\ProgramData\somov\Toolbox\somov-toolbox.ps1'
    Assert-MockCalled Copy-Item -Scope It -ParameterFilter { $Destination -eq 'C:\ProgramData\somov\Toolbox' }
    Assert-MockCalled New-ToolboxShortcut -Times 1 -Scope It
  }
  It 'the installed copy does not copy itself' {
    Mock Copy-Item { }
    Install-ToolboxCopy -From 'C:\ProgramData\somov\Toolbox' -To 'C:\ProgramData\somov\Toolbox' | Should BeNullOrEmpty
    Assert-MockCalled Copy-Item -Times 0 -Exactly -Scope It
  }
}
