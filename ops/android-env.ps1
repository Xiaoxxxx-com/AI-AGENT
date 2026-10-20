# Android 环境变量（PowerShell 会话内生效）
#
#   . .\ops\android-env.ps1
#
# 已通过「用户环境变量」持久化过 JAVA_HOME / ANDROID_HOME / PATH，
# 新开的终端一般不用再跑这个脚本；只有在旧终端里才需要。

$sdk = if ($env:ANDROID_HOME) { $env:ANDROID_HOME } else { "$env:LOCALAPPDATA\Android\Sdk" }
$jdkRoot = "$HOME\Android\jdk17"

if (-not $env:JAVA_HOME -and (Test-Path $jdkRoot)) {
  $jdk = Get-ChildItem $jdkRoot -Directory | Select-Object -First 1
  if ($jdk) { $env:JAVA_HOME = $jdk.FullName }
}

if (-not $env:ANDROID_HOME) { $env:ANDROID_HOME = $sdk }
$env:ANDROID_SDK_ROOT = $env:ANDROID_HOME

$paths = @(
  "$env:JAVA_HOME\bin",
  "$env:ANDROID_HOME\platform-tools",
  "$env:ANDROID_HOME\cmdline-tools\latest\bin"
) | Where-Object { $_ -and (Test-Path $_) }

foreach ($p in $paths) {
  if (($env:PATH -split ';') -notcontains $p) { $env:PATH = "$p;$env:PATH" }
}

Write-Host "JAVA_HOME    = $env:JAVA_HOME"
Write-Host "ANDROID_HOME = $env:ANDROID_HOME"
Write-Host "adb          = $((Get-Command adb -ErrorAction SilentlyContinue).Source)"
Write-Host "android      = $((Get-Command android -ErrorAction SilentlyContinue).Source)"
