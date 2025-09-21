@echo off
REM Embedded Note Titles Plugin Build Script for Windows

echo 🔨 Building Embedded Note Titles Plugin...

REM Check if Node.js is installed
node --version >nul 2>&1
if %errorlevel% neq 0 (
    echo ❌ Node.js is not installed. Please install Node.js first.
    pause
    exit /b 1
)

REM Check if npm is installed
npm --version >nul 2>&1
if %errorlevel% neq 0 (
    echo ❌ npm is not installed. Please install npm first.
    pause
    exit /b 1
)

REM Install dependencies
echo 📦 Installing dependencies...
npm install

if %errorlevel% neq 0 (
    echo ❌ Failed to install dependencies.
    pause
    exit /b 1
)

REM Build the plugin
echo 🏗️  Building plugin...
npm run build

if %errorlevel% neq 0 (
    echo ❌ Build failed.
    pause
    exit /b 1
)

echo ✅ Build completed successfully!
echo.
echo 📁 Plugin files:
echo    - main.js (compiled plugin)
echo    - manifest.json (plugin manifest)
echo    - styles.css (styles)
echo.
echo 🚀 To install the plugin:
echo    1. Copy the entire folder to your Obsidian vault's .obsidian/plugins/ directory
echo    2. Enable the plugin in Obsidian settings
echo.
echo 💡 For development, run 'npm run dev' to watch for changes.

pause
