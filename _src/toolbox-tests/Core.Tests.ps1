# Pester 3.4 tests for the somov Toolbox core functions.
# Run: powershell -NoProfile -Command "Invoke-Pester _src/toolbox-tests/Core.Tests.ps1"
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$script = Join-Path $root 'toolbox\somov-toolbox.ps1'
. $script
$feedPath = Join-Path $root 'toolbox\items.json'
$feed = Get-Content $feedPath -Raw -Encoding UTF8 | ConvertFrom-Json

Describe 'Get-ToolboxLanguage' {
  It 'ru-RU is Russian'   { Get-ToolboxLanguage 'ru-RU' | Should Be 'ru' }
  It 'en-US is English'   { Get-ToolboxLanguage 'en-US' | Should Be 'en' }
  It 'vi-VN falls back to English' { Get-ToolboxLanguage 'vi-VN' | Should Be 'en' }
}

Describe 'Get-OsFamily' {
  It '19044 is Windows 10' { Get-OsFamily 19044 | Should Be '10' }
  It '26100 is Windows 11' { Get-OsFamily 26100 | Should Be '11' }
  It '22000 is Windows 11' { Get-OsFamily 22000 | Should Be '11' }
}

Describe 'Compare-ToolboxVersion' {
  It 'compares numerically' { Compare-ToolboxVersion '1.10.0' '1.9.3' | Should Be 1 }
  It 'equal is 0'           { Compare-ToolboxVersion '1.0.0' '1.0.0' | Should Be 0 }
  It 'older is -1'          { Compare-ToolboxVersion '1.0.0' '1.0.1' | Should Be -1 }
}

Describe 'Get-ToolboxFeed' {
  It 'falls back to the cache when the site cannot be reached' {
    Mock Invoke-RestMethod { throw 'no network' }
    $r = Get-ToolboxFeed -Url 'https://somov.org/toolbox/items.json' -CachePath $feedPath
    $r.Offline | Should Be $true
    @($r.Feed.items).Count | Should Be 33
  }
  It 'without a cache returns an empty feed, offline' {
    Mock Invoke-RestMethod { throw 'no network' }
    $r = Get-ToolboxFeed -Url 'https://somov.org/toolbox/items.json' -CachePath (Join-Path $env:TEMP 'somov-no-such-cache.json')
    $r.Offline | Should Be $true
    @($r.Feed.items).Count | Should Be 0
  }
  It 'online writes the cache and is not offline' {
    $cache = Join-Path $env:TEMP 'somov-cache-test.json'
    Remove-Item $cache -ErrorAction SilentlyContinue
    Mock Invoke-RestMethod { $feed }
    $r = Get-ToolboxFeed -Url 'https://somov.org/toolbox/items.json' -CachePath $cache
    $r.Offline | Should Be $false
    Test-Path $cache | Should Be $true
    Remove-Item $cache
  }
}

Describe 'Select-ToolboxItems' {
  $m10 = Select-ToolboxItems -Feed $feed -Os '10'
  $all10 = @($m10.Categories.Values | ForEach-Object { $_ }) + @($m10.Advanced)
  It 'hides Windows 11 items on Windows 10' { ($all10 | Where-Object id -eq 'old-context-menu') | Should BeNullOrEmpty }
  It 'keeps Windows 10 items on Windows 10' { ($all10 | Where-Object id -eq 'turn-off-telemetry') | Should Not BeNullOrEmpty }
  It 'puts exactly the 3 advanced items in Advanced' {
    (@($m10.Advanced).id | Sort-Object) -join ',' | Should Be 'defender-remover,pause-updates,remove-edge'
  }
  It 'advanced items are not in the categories' {
    (@($m10.Categories.Values | ForEach-Object { $_ }) | Where-Object id -eq 'remove-edge') | Should BeNullOrEmpty
  }
  It 'recommends VC++ and DirectX' { (@($m10.Recommended).id) -join ',' | Should Be 'vcpp-runtimes,directx' }
  It 'keeps the site category order' { @($m10.Categories.Keys)[0] | Should Be 'tweaks' }
  $m11 = Select-ToolboxItems -Feed $feed -Os '11'
  It 'hides Windows 10 items on Windows 11' {
    (@($m11.Categories.Values | ForEach-Object { $_ }) | Where-Object id -eq 'turn-off-telemetry') | Should BeNullOrEmpty
  }
}

Describe 'Get-ItemAction' {
  It 'archive with run is archive-run' { Get-ItemAction ([pscustomobject]@{ kind = 'archive'; run = 'install_all.bat' }) | Should Be 'archive-run' }
  It 'archive without run is archive-open' { Get-ItemAction ([pscustomobject]@{ kind = 'archive' }) | Should Be 'archive-open' }
  It 'reg stays reg' { Get-ItemAction ([pscustomobject]@{ kind = 'reg' }) | Should Be 'reg' }
  It 'unknown kind becomes link' { Get-ItemAction ([pscustomobject]@{ kind = 'holo' }) | Should Be 'link' }
}

Describe 'Encoding' {
  It 'the script is UTF-8 with BOM (PowerShell 5.1 needs it for Russian text)' {
    $b = [IO.File]::ReadAllBytes($script)
    ('{0:X2}{1:X2}{2:X2}' -f $b[0], $b[1], $b[2]) | Should Be 'EFBBBF'
  }
}
