# OneSim Database Setup Script
# Run this script as Administrator if needed

Write-Host "=== OneSim Africa Database Setup ===" -ForegroundColor Cyan
Write-Host ""

# Find PostgreSQL installation
$pgInstall = Get-ItemProperty "HKLM:\SOFTWARE\PostgreSQL\Installations\*" -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $pgInstall) {
    $pgInstall = Get-ChildItem "C:\Program Files\PostgreSQL\" -Directory -ErrorAction SilentlyContinue | Select-Object -First 1
}

if (-not $pgInstall) {
    Write-Host "PostgreSQL installation not found!" -ForegroundColor Red
    Write-Host "Please install PostgreSQL or update this script with the correct path." -ForegroundColor Yellow
    exit 1
}

$pgBin = if ($pgInstall.InstallDir) { Join-Path $pgInstall.InstallDir "bin" } else { Join-Path $pgInstall.FullName "bin" }
$psqlPath = Join-Path $pgBin "psql.exe"

Write-Host "Found PostgreSQL at: $pgBin" -ForegroundColor Green
Write-Host ""

# Prompt for password
$password = Read-Host "Enter PostgreSQL postgres user password" -AsSecureString
$cred = New-Object System.Management.Automation.PSCredential("postgres", $password)
$plainPassword = $cred.GetNetworkCredential().Password

# Set environment variable for password
$env:PGPASSWORD = $plainPassword

# Create database
Write-Host "Creating database 'onesim_africa'..." -ForegroundColor Yellow
& $psqlPath -U postgres -c "CREATE DATABASE onesim_africa;" 2>&1

if ($LASTEXITCODE -eq 0) {
    Write-Host "Database created successfully!" -ForegroundColor Green
} else {
    Write-Host "Database might already exist or there was an error." -ForegroundColor Yellow
}

# Update .env file
$envContent = @"
# Database - Update with your actual password
DATABASE_URL="postgresql://postgres:$plainPassword@localhost:5432/onesim_africa?schema=public"

# NextAuth
NEXTAUTH_SECRET="onesim-africa-secret-key-2026-production-ready-32chars"
NEXTAUTH_URL="http://localhost:3000"

# App
NEXT_PUBLIC_APP_URL="http://localhost:3000"
"@

Set-Content -Path ".env" -Value $envContent
Write-Host ".env file updated with your password!" -ForegroundColor Green
Write-Host ""

# Run Prisma migration
Write-Host "Running Prisma migration..." -ForegroundColor Yellow
npx prisma migrate dev --name init

if ($LASTEXITCODE -eq 0) {
    Write-Host "Migration completed!" -ForegroundColor Green
    
    # Seed database
    Write-Host "Seeding database..." -ForegroundColor Yellow
    npx ts-node prisma/seed.ts
    
    Write-Host ""
    Write-Host "=== Setup Complete! ===" -ForegroundColor Green
    Write-Host "Run 'npm run dev' to start the server" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "Default Login Credentials:" -ForegroundColor Yellow
    Write-Host "Admin: admin@onesim.africa / admin123" -ForegroundColor White
    Write-Host "Business: business@company.com / business123" -ForegroundColor White
} else {
    Write-Host "Migration failed. Please check your database connection." -ForegroundColor Red
}
