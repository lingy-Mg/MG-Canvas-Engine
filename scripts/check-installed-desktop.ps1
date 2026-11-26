#Requires -Version 7.4
[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$Installer,
  [string]$EvidenceDirectory = 'dist/qa/windows-installed',
  [string]$PreviousInstaller
)
$ErrorActionPreference = 'Stop'
if (!$IsWindows) { throw 'This smoke test requires a Windows desktop session.' }

$installerPath = (Resolve-Path -LiteralPath $Installer).ProviderPath
$previousPath = if ($PreviousInstaller) { (Resolve-Path -LiteralPath $PreviousInstaller).ProviderPath }
$evidence = [IO.Directory]::CreateDirectory([IO.Path]::GetFullPath($EvidenceDirectory)).FullName
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$source = Join-Path $repo 'docs\fixtures'
$notices = @('LICENSE', 'THIRD-PARTY-NOTICES.md', 'THIRD-PARTY-RUST.txt')
$uninstallRegistry = @(
  'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
  'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
  'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
)
$classes = 'HKCU:\Software\Classes'
$extension = "$classes\.mgcanvas"
$progId = 'MGCanvas.Project'

function Get-InstalledCanvas {
  Get-ItemProperty -Path $uninstallRegistry -ErrorAction SilentlyContinue |
    Where-Object { $_.DisplayName -eq 'MG Canvas' -or $_.MainBinaryName -eq 'mg-canvas-desktop.exe' }
}
function Get-AssociationDefaults {
  $choice = Get-ItemProperty -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\.mgcanvas\UserChoice' -ErrorAction SilentlyContinue
  [ordered]@{
    User = [string](Get-Item -LiteralPath $extension -ErrorAction SilentlyContinue)?.GetValue('')
    Machine = [string](Get-Item -LiteralPath 'HKLM:\Software\Classes\.mgcanvas' -ErrorAction SilentlyContinue)?.GetValue('')
    Choice = $choice.ProgId
    ChoiceHash = $choice.Hash
  }
}
function Assert-AssociationDefaults($Expected, [string]$Stage) {
  if (((Get-AssociationDefaults) | ConvertTo-Json -Compress) -ne ($Expected | ConvertTo-Json -Compress)) {
    throw "$Stage changed an existing association default."
  }
}
if ((Get-InstalledCanvas) -or (Test-Path -LiteralPath "$classes\$progId")) {
  throw 'This account already has a registered MG Canvas installation or project handler. Use a separate test account.'
}
$associationBefore = Get-AssociationDefaults
$testDefault = !$associationBefore.User -and !$associationBefore.Machine -and !$associationBefore.Choice

Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class MgCanvasShell {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  private struct ShellInfo {
    public int size;
    public uint mask;
    public IntPtr window;
    public string verb, file, parameters, directory;
    public int show;
    public IntPtr instance, idList;
    public string className;
    public IntPtr classKey;
    public uint hotkey;
    public IntPtr icon, process;
  }

  [DllImport("shell32.dll", EntryPoint = "ShellExecuteExW", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern bool ShellExecuteEx(ref ShellInfo info);
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern uint GetProcessId(IntPtr process);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);
  [DllImport("kernel32.dll")]
  public static extern bool CloseHandle(IntPtr handle);

  public static IntPtr Open(string file, string className) {
    bool useDefault = string.IsNullOrEmpty(className);
    uint mask = useDefault ? 0x540u : 0x541u;
    var info = new ShellInfo { size = Marshal.SizeOf<ShellInfo>(), mask = mask,
      verb = useDefault ? null : "open", file = file, className = className, show = 1 };
    if (!ShellExecuteEx(ref info)) throw new Win32Exception(Marshal.GetLastWin32Error());
    if (info.process == IntPtr.Zero) throw new InvalidOperationException("Shell association did not return a process.");
    return info.process;
  }

  public static uint WaitForExit(IntPtr handle, uint milliseconds) {
    if (WaitForSingleObject(handle, milliseconds) != 0 || !GetExitCodeProcess(handle, out uint code))
      throw new InvalidOperationException("Associated process did not exit in time.");
    return code;
  }
}
'@

function Assert-Canvas([bool]$Condition, [string]$Message) {
  if (!$Condition) { throw $Message }
}
function Invoke-Canvas([string[]]$Arguments, [switch]$AllowFailure) {
  $start = [Diagnostics.ProcessStartInfo]::new($cli)
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  [void]$start.Environment.Remove('WEBVIEW2_USER_DATA_FOLDER')
  foreach ($argument in $Arguments) { $start.ArgumentList.Add($argument) }
  $command = [Diagnostics.Process]::Start($start)
  try {
    $output = $command.StandardOutput.ReadToEndAsync()
    $errors = $command.StandardError.ReadToEndAsync()
    if (!$command.WaitForExit(90000)) {
      $command.Kill($true)
      $command.WaitForExit()
      throw "mgcanvas timed out ($($Arguments[0]))."
    }
    $result = ConvertFrom-Json -InputObject $output.Result -AsHashtable
    if (!$AllowFailure -and ($command.ExitCode -ne 0 -or $result.ok -ne $true)) {
      throw "mgcanvas $($Arguments[0]) failed ($($command.ExitCode)): $($output.Result) $($errors.Result)"
    }
    Assert-Canvas (($command.ExitCode -eq 0) -eq ($result.ok -eq $true)) 'CLI exit code and JSON result disagree.'
    return $result
  } finally { $command.Dispose() }
}
function Wait-Board([string]$Id) {
  $until = [Diagnostics.Stopwatch]::StartNew()
  do {
    $board = Invoke-Canvas -Arguments @('read') -AllowFailure
    if ($board.ok -and $board.board.id -eq $Id) { return $board }
    Start-Sleep -Milliseconds 200
  } while ($until.Elapsed.TotalSeconds -lt 35)
  throw "The workbench did not open board $Id. Last read: $($board | ConvertTo-Json -Depth 10 -Compress)"
}
function Confirm-HotOpen([string]$Path, [string]$Class, [string]$Id) {
  $handle = [MgCanvasShell]::Open($Path, $Class)
  try {
    Assert-Canvas (([MgCanvasShell]::GetProcessId($handle) -ne $cold.Id) -and ([MgCanvasShell]::WaitForExit($handle, 35000) -eq 0)) 'The second shell launch did not hand off to the existing window.'
    $board = Wait-Board $Id
    Assert-Canvas (!$cold.HasExited) 'Hot open closed the existing workbench.'
    return $board
  } finally { [void][MgCanvasShell]::CloseHandle($handle) }
}
function Invoke-Tool([string]$Name, [hashtable]$Arguments) {
  $jsonPath = Join-Path $scratch 'tool-arguments.json'
  $Arguments | ConvertTo-Json -Depth 20 -Compress | Set-Content -LiteralPath $jsonPath -Encoding utf8
  Invoke-Canvas -Arguments @('call', $Name, '--args-file', $jsonPath)
}
function Assert-Png([string]$Path, [hashtable]$Result) {
  $image = [Drawing.Bitmap]::new($Path)
  try {
    Assert-Canvas ($image.Width -eq $Result.width -and $image.Height -eq $Result.height) "PNG dimensions disagreed at $Path."
    $colors = [Collections.Generic.HashSet[int]]::new()
    $xStep = [Math]::Max(1, [int][Math]::Floor($image.Width / 48))
    $yStep = [Math]::Max(1, [int][Math]::Floor($image.Height / 48))
    for ($y = 0; $y -lt $image.Height; $y += $yStep) {
      for ($x = 0; $x -lt $image.Width; $x += $xStep) {
        $pixel = $image.GetPixel($x, $y)
        if ($pixel.A -gt 0) { [void]$colors.Add($pixel.ToArgb()) }
      }
    }
    Assert-Canvas ($colors.Count -gt 8) "The PNG at $Path was blank or had no drawing detail."
  } finally { $image.Dispose() }
  Assert-Canvas ((Get-FileHash -LiteralPath $Path).Hash -eq $Result.sha256) "PNG checksum disagreed at $Path."
}
function Install-Canvas([string]$Path) {
  # NSIS treats /D as a raw final argument, including spaces in the path.
  $setup = Start-Process -FilePath $Path -ArgumentList "/S /NS /D=$installDir" -Wait -PassThru -WindowStyle Hidden
  Assert-Canvas ($setup.ExitCode -eq 0) "NSIS returned $($setup.ExitCode)."
  $registration = Get-InstalledCanvas
  Assert-Canvas ($registration -and $registration.InstallLocation.Trim('"') -eq $installDir) 'Unexpected NSIS registration.'
}

$scratch = [IO.Directory]::CreateTempSubdirectory('mgcanvas-installed-').FullName
$installDir = Join-Path $scratch 'install'
$cli = Join-Path $installDir 'mgcanvas.exe'
$gui = Join-Path $installDir 'mg-canvas-desktop.exe'
$uninstaller = Join-Path $installDir 'uninstall.exe'
$oldInstance = $env:MGCANVAS_INSTANCE
$oldProfile = $env:WEBVIEW2_USER_DATA_FOLDER
$env:MGCANVAS_INSTANCE = [guid]::NewGuid().ToString()
$env:WEBVIEW2_USER_DATA_FOLDER = Join-Path $scratch 'workbench-profile'
$coldHandle = [IntPtr]::Zero
$cold = $null
$transcript = $false
try {
  Start-Transcript -LiteralPath (Join-Path $evidence 'native-smoke.log') -NoClobber | Out-Null
  $transcript = $true
  if ($previousPath) { Install-Canvas $previousPath }
  Install-Canvas $installerPath
  Assert-Canvas ((Test-Path -LiteralPath $gui -PathType Leaf) -and (Test-Path -LiteralPath $cli -PathType Leaf)) 'NSIS did not deploy both binaries.'
  foreach ($notice in $notices) {
    Assert-Canvas ((Get-FileHash -LiteralPath (Join-Path $installDir $notice)).Hash -eq (Get-FileHash -LiteralPath (Join-Path $repo $notice)).Hash) "Installed notice differs from checkout: $notice"
  }
  $version = Invoke-Canvas -Arguments @('--version')
  Write-Host "Installed GUI and CLI $($version.version); NSIS SHA-256 $((Get-FileHash -LiteralPath $installerPath).Hash)"
  $associationExpected = [ordered]@{}
  foreach ($key in $associationBefore.Keys) { $associationExpected[$key] = $associationBefore[$key] }
  if ($testDefault) { $associationExpected.User = $progId }
  Assert-AssociationDefaults $associationExpected 'Install'
  $registered = Get-Item -LiteralPath "$classes\$progId"
  Assert-Canvas ($registered.GetValue('') -eq 'MG Canvas 画板') 'Missing file type display name.'
  Assert-Canvas ((Get-Item -LiteralPath "$classes\$progId\DefaultIcon").GetValue('') -eq ('"{0}",0' -f $gui)) 'Unexpected association icon.'
  Assert-Canvas ((Get-Item -LiteralPath "$classes\$progId\shell\open\command").GetValue('') -eq ('"{0}" "%1"' -f $gui)) 'Unexpected association command.'
  Assert-Canvas ((Get-Item -LiteralPath "$extension\OpenWithProgids").GetValueNames() -contains $progId) 'Missing Open With registration.'

  $coldFile = Join-Path $scratch '冷启动 会议室.mgcanvas'
  $hotFile = Join-Path $scratch '热打开 预约流程.mgcanvas'
  Copy-Item -LiteralPath "$source\M5AG-Layer-Locks.mgcanvas" -Destination $coldFile
  Copy-Item -LiteralPath "$source\Meeting-Room-Mobile-QA.mgcanvas" -Destination $hotFile
  $coldId = (Get-Content -LiteralPath $coldFile -Raw | ConvertFrom-Json -AsHashtable).document.id
  $fixture = Get-Content -LiteralPath $hotFile -Raw | ConvertFrom-Json -AsHashtable
  $coldHash = (Get-FileHash -LiteralPath $coldFile).Hash
  $hotHash = (Get-FileHash -LiteralPath $hotFile).Hash

  $withoutWindow = Invoke-Canvas -Arguments @('read') -AllowFailure
  Assert-Canvas (!$withoutWindow.ok -and $withoutWindow.code -eq 'NO_WINDOW') 'The test instance unexpectedly had a workbench before startup.'
  Add-Type -AssemblyName System.Drawing.Common
  $filePng = Join-Path $evidence 'project-file.png'
  $file = Invoke-Canvas -Arguments @('png', '--file', $hotFile, '--out', $filePng)
  Assert-Png $filePng $file
  Write-Host "PASS: standalone project PNG rendered without a workbench ($($file.width)x$($file.height))."

  # Without a pre-existing default, omit the class to exercise the same lookup as double-click.
  $shellClass = if (!$testDefault) { $progId }
  $coldHandle = [MgCanvasShell]::Open($coldFile, $shellClass)
  $cold = [Diagnostics.Process]::GetProcessById([MgCanvasShell]::GetProcessId($coldHandle))
  Assert-Canvas ($cold.MainModule.FileName -eq $gui) 'Shell launched an unexpected executable.'
  $null = Wait-Board $coldId
  Assert-Canvas (Test-Path -LiteralPath $env:WEBVIEW2_USER_DATA_FOLDER -PathType Container) 'Workbench did not use the isolated WebView2 data folder.'
  $board = Confirm-HotOpen $hotFile $shellClass $fixture.document.id
  if ($testDefault) {
    Write-Host 'PASS: Windows default Shell action cold- and hot-opened Chinese paths with spaces.'
    $null = Confirm-HotOpen $coldFile $progId $coldId
    $board = Confirm-HotOpen $hotFile $progId $fixture.document.id
  }
  $tools = Invoke-Canvas -Arguments @('tools')
  Assert-Canvas ($tools.tools.name -contains 'canvas_edit' -and $tools.tools.name -contains 'canvas_history') 'CLI tool discovery is incomplete.'
  $invalidFile = Join-Path $scratch '无效 工程.mgcanvas'
  '{}' | Set-Content -LiteralPath $invalidFile -Encoding utf8
  $invalid = Invoke-Canvas -Arguments @('open', $invalidFile) -AllowFailure
  Assert-Canvas (!$invalid.ok -and (Invoke-Canvas -Arguments @('read')).board.id -eq $fixture.document.id) 'Invalid project replaced the open board.'
  Write-Host 'PASS: the explicitly selected Open With handler opened the project; installed CLI discovered and read the board.'

  $label = '已安装控制台改字'
  $edit = Invoke-Tool 'canvas_edit' @{
    baseRevision=$board.revision; operationId=[guid]::NewGuid().ToString()
    operations=@(@{op='update'; id='flow-submit'; fields=@{label=$label}})
  }
  $changed = Invoke-Tool 'canvas_read' @{ids=@('flow-submit')}
  Assert-Canvas ($changed.objects[0].label -eq $label) 'CLI edit did not reach the active workbench.'
  $null = Invoke-Tool 'canvas_history' @{baseRevision=$edit.revision; operationId=[guid]::NewGuid().ToString(); action='undo'}
  $roundtrip = Join-Path $evidence 'installed-workbench.mgcanvas'
  $null = Invoke-Canvas -Arguments @('export', '--out', $roundtrip)
  $exported = Get-Content -LiteralPath $roundtrip -Raw | ConvertFrom-Json -AsHashtable
  Assert-Canvas ($exported.document.objects['flow-submit'].label -eq $fixture.document.objects['flow-submit'].label) 'Undo did not restore the label.'
  Assert-Canvas (($exported.assets | ConvertTo-Json -Depth 15 -Compress) -eq ($fixture.assets | ConvertTo-Json -Depth 15 -Compress)) 'The installed round-trip changed the embedded image.'
  Write-Host 'PASS: installed CLI edit, shared undo and export preserved the embedded image.'

  $activePng = Join-Path $evidence 'active-workbench.png'
  $active = Invoke-Canvas -Arguments @('png', '--active', '--out', $activePng)
  Assert-Png $activePng $active
  Assert-Canvas ($active.width -eq $file.width -and $active.height -eq $file.height -and $active.sha256 -eq $file.sha256) 'Active and file rendering disagreed after undo.'
  Assert-Canvas (((Get-FileHash -LiteralPath $coldFile).Hash -eq $coldHash) -and ((Get-FileHash -LiteralPath $hotFile).Hash -eq $hotHash)) 'A source project file changed.'
  Write-Host "PASS: active and file PNG rendered identical nonblank content ($($file.width)x$($file.height)); source projects unchanged."
} catch {
  Write-Host "FAIL: $($_.Exception.Message)"
  throw
} finally {
  try {
    if ($cold -and !$cold.HasExited) {
      [void]$cold.CloseMainWindow()
      if (!$cold.WaitForExit(8000)) { $cold.Kill($true); $cold.WaitForExit() }
    }
    if ($coldHandle -ne [IntPtr]::Zero) { [void][MgCanvasShell]::CloseHandle($coldHandle) }
    if (Test-Path -LiteralPath $uninstaller -PathType Leaf) {
      $remove = Start-Process -FilePath $uninstaller -ArgumentList '/S' -Wait -PassThru -WindowStyle Hidden
      Assert-Canvas ($remove.ExitCode -eq 0 -and !(Test-Path -LiteralPath $gui) -and !(Test-Path -LiteralPath $cli) -and !(Get-InstalledCanvas)) 'NSIS did not uninstall the test installation.'
      foreach ($notice in $notices) {
        Assert-Canvas (!(Test-Path -LiteralPath (Join-Path $installDir $notice))) "Uninstall left the notice $notice."
      }
      $openWith = Get-Item -LiteralPath "$extension\OpenWithProgids" -ErrorAction SilentlyContinue
      Assert-Canvas (!(Test-Path -LiteralPath "$classes\$progId") -and !($openWith -and $openWith.GetValueNames() -contains $progId)) 'Uninstall left the MG Canvas handler registered.'
      Assert-AssociationDefaults $associationBefore 'Uninstall'
      Write-Host 'PASS: uninstall removed GUI, CLI and this handler without changing default programs.'
    }
  } finally {
    $env:MGCANVAS_INSTANCE = $oldInstance
    $env:WEBVIEW2_USER_DATA_FOLDER = $oldProfile
    $resolvedScratch = [IO.Path]::GetFullPath($scratch)
    $tempRoot = [IO.Path]::TrimEndingDirectorySeparator([IO.Path]::GetFullPath([IO.Path]::GetTempPath()))
    if ([IO.Path]::GetDirectoryName($resolvedScratch).Equals($tempRoot, [StringComparison]::OrdinalIgnoreCase) -and
      [IO.Path]::GetFileName($resolvedScratch).StartsWith('mgcanvas-installed-',[StringComparison]::Ordinal)) {
      try { [IO.Directory]::Delete($resolvedScratch, $true) }
      catch [IO.IOException] { Write-Warning "Could not remove temporary WebView2 data at $resolvedScratch." }
    }
    if ($transcript) { Stop-Transcript | Out-Null }
  }
}
