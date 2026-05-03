# deploy.ps1 — Run this from the project root to deploy to AWS Lambda
# Usage: .\deploy.ps1

$FUNCTION_NAME = "node-streaming-test"
$REGION = "us-east-1"
$BUILD_DIR = ".build"
$ZIP_FILE = "function.zip"

Write-Host "==> Cleaning previous build..." -ForegroundColor Cyan
if (Test-Path $BUILD_DIR) { Remove-Item -Recurse -Force $BUILD_DIR }
if (Test-Path $ZIP_FILE) { Remove-Item -Force $ZIP_FILE }

Write-Host "==> Installing dependencies..." -ForegroundColor Cyan
npm install --omit=dev
if ($LASTEXITCODE -ne 0) { Write-Host "npm install failed" -ForegroundColor Red; exit 1 }

Write-Host "==> Creating build directory..." -ForegroundColor Cyan
New-Item -ItemType Directory -Path $BUILD_DIR | Out-Null

Write-Host "==> Copying files into build directory..." -ForegroundColor Cyan
Copy-Item -Recurse "src" "$BUILD_DIR\src"
Copy-Item -Recurse "node_modules" "$BUILD_DIR\node_modules"
Copy-Item "package.json" "$BUILD_DIR\package.json"

Write-Host "==> Zipping from inside build directory..." -ForegroundColor Cyan
Push-Location $BUILD_DIR
    Compress-Archive -Path ".\*" -DestinationPath "..\$ZIP_FILE" -Force
Pop-Location

$size = [math]::Round((Get-Item $ZIP_FILE).Length / 1MB, 2)
Write-Host "==> Zip size: $size MB" -ForegroundColor Cyan

Write-Host "==> Deploying to Lambda: $FUNCTION_NAME..." -ForegroundColor Cyan
aws lambda update-function-code `
  --function-name $FUNCTION_NAME `
  --zip-file "fileb://$ZIP_FILE" `
  --region $REGION

if ($LASTEXITCODE -eq 0) {
  Write-Host "==> Deploy successful!" -ForegroundColor Green
} else {
  Write-Host "==> Deploy failed!" -ForegroundColor Red
  exit 1
}

Write-Host "==> Cleaning up..." -ForegroundColor Cyan
Remove-Item -Recurse -Force $BUILD_DIR
Remove-Item -Force $ZIP_FILE

Write-Host "==> Done!" -ForegroundColor Green