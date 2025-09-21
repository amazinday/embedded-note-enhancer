#!/bin/bash

# Embedded Note Titles Plugin Build Script

echo "🔨 Building Embedded Note Titles Plugin..."

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo "❌ Node.js is not installed. Please install Node.js first."
    exit 1
fi

# Check if npm is installed
if ! command -v npm &> /dev/null; then
    echo "❌ npm is not installed. Please install npm first."
    exit 1
fi

# Install dependencies
echo "📦 Installing dependencies..."
npm install

if [ $? -ne 0 ]; then
    echo "❌ Failed to install dependencies."
    exit 1
fi

# Build the plugin
echo "🏗️  Building plugin..."
npm run build

if [ $? -ne 0 ]; then
    echo "❌ Build failed."
    exit 1
fi

echo "✅ Build completed successfully!"
echo ""
echo "📁 Plugin files:"
echo "   - main.js (compiled plugin)"
echo "   - manifest.json (plugin manifest)"
echo "   - styles.css (styles)"
echo ""
echo "🚀 To install the plugin:"
echo "   1. Copy the entire folder to your Obsidian vault's .obsidian/plugins/ directory"
echo "   2. Enable the plugin in Obsidian settings"
echo ""
echo "💡 For development, run 'npm run dev' to watch for changes."
