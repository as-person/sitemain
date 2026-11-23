# Pester 3.4 tests for the toolbox window. WPF needs STA: powershell.exe 5.1 runs STA by default.
# Run: powershell -NoProfile -Command "Invoke-Pester _src/toolbox-tests/Ui.Tests.ps1"
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
. (Join-Path $root 'toolbox\somov-toolbox.ps1')
$feed = Get-Content (Join-Path $root 'toolbox\items.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$model = { param([bool]$offline) @{ Feed = $feed; Offline = $offline; Os = '11'; Selection = (Select-ToolboxItems -Feed $feed -Os '11'); OsText = 'Windows 11 IoT Enterprise LTSC 24H2 · 26100.9974' } }

Describe 'Start-Toolbox elevation' {
  It 'without admin rights it restarts itself elevated' {
    Mock Test-IsAdmin { $false }
    Mock Start-Process { }
    Start-Toolbox
    Assert-MockCalled Start-Process -Times 1 -Scope It -ParameterFilter { $Verb -eq 'RunAs' -and "$ArgumentList" -like '*somov-toolbox.ps1*' }
  }
  It 'a cancelled UAC prompt ends quietly' {
    Mock Test-IsAdmin { $false }
    Mock Start-Process { throw 'The operation was canceled by the user' }
    { Start-Toolbox } | Should Not Throw
  }
}

Describe 'New-ToolboxWindow' {
  $w = New-ToolboxWindow -Model (& $model $false) -Lang 'ru'
  It 'is the somov Toolbox window' { $w.Title | Should Match 'somov Toolbox' }
  It 'lists the 6 site categories and Advanced last' {
    $list = $w.FindName('CategoryList')
    $list.Items.Count | Should Be 7
    $list.Items[6].Tag | Should Be 'advanced'
  }
  It 'opens on the first category, not on Advanced' { $w.FindName('CategoryList').SelectedIndex | Should Be 0 }
  It 'links to the Telegram channel' { $w.FindName('TelegramButton').Tag | Should Match 't.me/windows_by_somov' }
  It 'shows the Windows line' { $w.FindName('OsText').Text | Should Match '26100' }
  It 'online: no banner, Apply enabled' {
    $w.FindName('OfflineBanner').Visibility | Should Be 'Collapsed'
    $w.FindName('ApplyButton').IsEnabled | Should Be $true
  }
  It 'the first category starts with the recommended items' {
    ($w.FindName('ItemsHost').Children[0] | Out-String) -ne '' | Should Be $true
    (Get-ToolboxChecks $w | Where-Object { $_.Tag.Item.id -eq 'vcpp-runtimes' }) | Should Not BeNullOrEmpty
  }
  It 'browsers get one tick box per browser' {
    @(Get-ToolboxChecks $w | Where-Object { $_.Tag.Item.id -eq 'browsers' }).Count | Should Be 4
  }
}

Describe 'Offline' {
  $w = New-ToolboxWindow -Model (& $model $true) -Lang 'ru'
  It 'says the internet is needed and blocks Apply' {
    $w.FindName('OfflineBanner').Visibility | Should Be 'Visible'
    $w.FindName('OfflineText').Text | Should Match 'нужен интернет'
    $w.FindName('ApplyButton').IsEnabled | Should Be $false
    $w.FindName('RetryButton') | Should Not BeNullOrEmpty
  }
  It 'Check again with the internet back hides the banner and enables Apply' {
    Mock Get-ToolboxFeed { @{ Feed = $feed; Offline = $false } }
    $btn = $w.FindName('RetryButton')
    $btn.RaiseEvent((New-Object System.Windows.RoutedEventArgs ([System.Windows.Controls.Primitives.ButtonBase]::ClickEvent)))
    $w.FindName('OfflineBanner').Visibility | Should Be 'Collapsed'
    $w.FindName('ApplyButton').IsEnabled | Should Be $true
  }
}
