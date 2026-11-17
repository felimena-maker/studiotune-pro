# Renderiza los diseños de promo\src a PNG con Edge sin interfaz.
# Las capturas salen de `node promo/capturar.mjs` (la app en un móvil emulado, con datos de ejemplo).
$edge = 'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
$src = Join-Path $PSScriptRoot 'src'
$out = Join-Path $PSScriptRoot 'imagenes'
New-Item -ItemType Directory -Force $out | Out-Null
$designs = [ordered]@{ '1-portada' = '1200,630'; '2-acordes' = '1080,1080'; '3-afinador' = '1080,1080'; '4-funciones' = '1080,1350'; '5-privacidad' = '1080,1080' }
foreach ($name in $designs.Keys) {
    $png = Join-Path $out "$name.png"
    $url = ([Uri](Join-Path $src "$name.html")).AbsoluteUri
    $args = @('--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1',
        "--window-size=$($designs[$name])", '--virtual-time-budget=3000',
        "--user-data-dir=$env:TEMP\studiotune-edge-promo-$name", "--screenshot=$png", $url)
    $p = Start-Process $edge -ArgumentList $args -PassThru -RedirectStandardError "$env:TEMP\edge-err-$name.txt"
    if (-not $p.WaitForExit(40000)) { try { $p.Kill() } catch {} }
    "$name -> $(Test-Path $png)"
}
