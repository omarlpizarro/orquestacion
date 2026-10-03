# Genera review-bundle.diff para un PR, sin hacer checkout.
#
#   .\scripts\review-bundle.ps1 27
#
# Compara las ramas remotas (origin), así que no toca tu árbol de trabajo
# ni la rama en la que esté trabajando Claude Code, y siempre usa lo que
# está pusheado en GitHub, nunca una copia local atrasada.

param(
    [Parameter(Mandatory = $true)]
    [int]$Pr
)

$ErrorActionPreference = 'Stop'
$repo = 'omarlpizarro/orquestacion'
$out = 'review-bundle.diff'

# Rama del PR y su base, por la API (gh pr view falla por Projects classic).
$branch = gh api "repos/$repo/pulls/$Pr" --jq .head.ref
$base = gh api "repos/$repo/pulls/$Pr" --jq .base.ref
if (-not $branch) { throw "No encontré el PR #$Pr." }

git fetch origin --quiet
if ($LASTEXITCODE -ne 0) { throw 'Falló git fetch.' }

# --output hace que git escriba el archivo directamente, byte por byte:
# sin pasar por PowerShell, no hay BOM ni acentos rotos.
git diff "origin/$base...origin/$branch" --output=$out
if ($LASTEXITCODE -ne 0) { throw 'Falló git diff.' }

$commit = git log --oneline -1 "origin/$branch"
$files = (git diff --name-only "origin/$base...origin/$branch" | Measure-Object).Count
$size = (Get-Item $out).Length

Write-Host ''
Write-Host "PR #$Pr  $branch -> $base"
Write-Host "Commit:  $commit"
Write-Host "Archivos: $files   Tamaño: $size bytes"

if ($size -eq 0) {
    Write-Host ''
    Write-Host 'ATENCIÓN: el diff está vacío. ¿El PR ya está mergeado o no tiene commits?' -ForegroundColor Yellow
} else {
    Write-Host ''
    Write-Host "Listo: $out. Subilo junto con el resumen de Claude Code." -ForegroundColor Green
}
