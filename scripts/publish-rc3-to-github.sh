#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if ! command -v git >/dev/null 2>&1; then
  echo "Git is required. Install Apple's Command Line Tools or Git first." >&2
  exit 1
fi
if [[ -e .git ]]; then
  echo "This folder already contains a .git directory. Refusing to change an existing repository." >&2
  exit 1
fi
if [[ ! -f package.json ]] || [[ "$(node -p "require('./package.json').version")" != "1.0.0-rc.3" ]]; then
  echo "This script is intended for the EZ Preview 1.0.0-rc.3 source folder." >&2
  exit 1
fi

REMOTE_URL="${1:-}"
if [[ -z "$REMOTE_URL" ]]; then
  read -r -p "Paste the URL of your EMPTY private GitHub repository: " REMOTE_URL
fi
if [[ ! "$REMOTE_URL" =~ ^(https://github\.com/|git@github\.com:) ]]; then
  echo "Please provide a GitHub HTTPS or SSH repository URL." >&2
  exit 1
fi

cat <<'EOF'
About to publish EZ Preview v1.0.0-rc.3 source to the GitHub repository you specified.
The first push will trigger the release-candidate build workflow. This script will NOT upload signing certificates or .env files, which are excluded by .gitignore.
EOF
read -r -p "Type PUSH to continue: " CONFIRM
if [[ "$CONFIRM" != "PUSH" ]]; then
  echo "Canceled without creating a repository or pushing files."
  exit 0
fi

git init -b main
git add .
git commit -m "Prepare EZ Preview v1.0.0-rc.3 release candidate"
git remote add origin "$REMOTE_URL"
git push -u origin main
git tag -a v1.0.0-rc.3 -m "EZ Preview v1.0.0-rc.3 release candidate"
git push origin v1.0.0-rc.3

echo
echo "Published source and tag v1.0.0-rc.3. Open the repository's Actions tab and monitor the build jobs."
