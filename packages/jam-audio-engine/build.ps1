$ErrorActionPreference = "Stop"

$crateRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Push-Location $crateRoot

try {
  if (-not (Get-Command wasm-pack -ErrorAction SilentlyContinue)) {
    throw "wasm-pack is required. Install it with 'cargo install wasm-pack'."
  }

  wasm-pack build --target web --release

  $pkgDir = Join-Path $crateRoot "pkg"
  $artifactNames = @(
    "jam_audio_engine_bg.wasm",
    "jam_audio_engine.js"
  )

  $webPkgDir = Join-Path $crateRoot "..\..\apps\jamdisc_web\web\pkg"
  if (-not (Test-Path $webPkgDir)) {
    New-Item -ItemType Directory -Path $webPkgDir -Force | Out-Null
  }

  foreach ($artifactName in $artifactNames) {
    $source = Join-Path $pkgDir $artifactName
    if (-not (Test-Path $source)) {
      throw "Expected build artifact '$artifactName' was not created."
    }

    Copy-Item -LiteralPath $source -Destination $webPkgDir -Force
  }
}
finally {
  Pop-Location
}
