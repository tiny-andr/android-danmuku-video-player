$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$cache = Join-Path $root 'bplayer-android/src-tauri/gen/android/.gradle-network-home/caches/modules-2/files-2.1'
$output = Join-Path $root ('tmp/thumbnail-check-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $output -Force | Out-Null
$compiler = @('org.jetbrains.kotlin/kotlin-compiler-embeddable', 'org.jetbrains.kotlin/kotlin-stdlib', 'org.jetbrains.kotlin/kotlin-script-runtime', 'org.jetbrains.kotlin/kotlin-reflect', 'org.jetbrains.kotlinx/kotlinx-coroutines-core-jvm', 'org.jetbrains/annotations') | ForEach-Object {
  Get-ChildItem (Join-Path $cache $_) -Recurse -Filter *.jar | Sort-Object FullName -Descending | Select-Object -First 1 -ExpandProperty FullName
}
$stdlib = $compiler | Where-Object { (Split-Path $_ -Leaf).StartsWith('kotlin-stdlib-') } | Select-Object -First 1
$java = if ($env:JAVA_HOME) { Join-Path $env:JAVA_HOME 'bin/java.exe' } else { 'java' }
$source = Join-Path $root 'bplayer-android/src-tauri/gen/android/app/src/main/java/com/danmuku/bplayer/android'
& $java -cp ($compiler -join [IO.Path]::PathSeparator) org.jetbrains.kotlin.cli.jvm.K2JVMCompiler -no-stdlib -no-reflect -classpath $stdlib -d (Join-Path $output 'core.jar') (Join-Path $source 'ThumbnailCore.kt') (Join-Path $PSScriptRoot 'thumbnail-core-check.kt')
if ($LASTEXITCODE -ne 0) { throw 'Thumbnail core compilation failed' }
& $java -cp ((Join-Path $output 'core.jar'), $stdlib -join [IO.Path]::PathSeparator) com.danmuku.bplayer.android.Thumbnail_core_checkKt $output
if ($LASTEXITCODE -ne 0) { throw 'Thumbnail core checks failed' }
$androidHome = if ($env:ANDROID_HOME) { $env:ANDROID_HOME } else { $env:ANDROID_SDK_ROOT }
if ($androidHome) {
  $androidJar = Get-ChildItem (Join-Path $androidHome 'platforms') -Recurse -Filter android.jar | Sort-Object FullName -Descending | Select-Object -First 1 -ExpandProperty FullName
  Set-Content -Path (Join-Path $output 'Keep.kt') -Value 'package androidx.annotation; annotation class Keep' -Encoding utf8
  & $java -cp ($compiler -join [IO.Path]::PathSeparator) org.jetbrains.kotlin.cli.jvm.K2JVMCompiler -no-stdlib -no-reflect -classpath ($stdlib, $androidJar -join [IO.Path]::PathSeparator) -d (Join-Path $output 'android.jar') (Join-Path $source 'ThumbnailCore.kt') (Join-Path $source 'AndroidThumbnails.kt') (Join-Path $source 'ThumbnailDecodeService.kt') (Join-Path $output 'Keep.kt')
  if ($LASTEXITCODE -ne 0) { throw 'Thumbnail Android API compilation failed' }
  Write-Output 'Thumbnail Android bridge/service API compilation passed'
}
Write-Output "Test artifacts: $output"
