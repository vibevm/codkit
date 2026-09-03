$ErrorActionPreference = 'Stop'

$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$launcher = Join-Path $repoRoot 'codkit/bin/codkit.mjs'
$node = Get-Command node -ErrorAction SilentlyContinue

if ($null -eq $node) {
	[Console]::Error.WriteLine('error CK-E-DEPS-MISSING: node is not available on PATH')
	[Console]::Error.WriteLine('hint: install the Node version required by the managed fork tree')
	exit 2
}

& $node.Source $launcher @args
if ($null -eq $LASTEXITCODE) {
	exit 2
}
exit $LASTEXITCODE
