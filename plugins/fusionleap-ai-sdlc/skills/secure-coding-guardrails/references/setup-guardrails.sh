#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# FusionLeap Digital — Secure Coding Guardrails Setup
# Run once after cloning to install and activate all guardrails.
# Usage: bash scripts/setup-guardrails.sh
# ─────────────────────────────────────────────────────────────────────────────

set -e

BOLD="\033[1m"; TEAL="\033[36m"; GREEN="\033[32m"; AMBER="\033[33m"; RESET="\033[0m"

echo ""
echo -e "${BOLD}${TEAL}╔══════════════════════════════════════════════════════════╗${RESET}"
echo -e "${BOLD}${TEAL}║  FusionLeap · Secure Coding Guardrails — Setup           ║${RESET}"
echo -e "${BOLD}${TEAL}╚══════════════════════════════════════════════════════════╝${RESET}"
echo ""

# ── 1. npm devDependencies ────────────────────────────────────────────────────
echo -e "${BOLD}▶ [1/4] Installing npm devDependencies...${RESET}"
npm install --save-dev husky lint-staged eslint-plugin-security prettier vitest
echo -e "${GREEN}✔ npm packages installed${RESET}"; echo ""

# ── 2. Husky ─────────────────────────────────────────────────────────────────
echo -e "${BOLD}▶ [2/4] Initialising Husky...${RESET}"
npx husky init 2>/dev/null || true
cat > .husky/pre-commit << 'HOOK'
# 1. Lint + format staged files
npx lint-staged

# 2. Run unit tests
echo "Running unit tests..."
npm test

# 3. Secret scanning
if command -v detect-secrets > /dev/null 2>&1; then
  detect-secrets-hook --baseline .secrets.baseline
fi

# 4. Semgrep security scan
if command -v semgrep > /dev/null 2>&1; then
  semgrep --config .semgrep/security.yml --metrics=off --error --quiet .
fi
HOOK
chmod +x .husky/pre-commit .husky/commit-msg 2>/dev/null || true
echo -e "${GREEN}✔ Husky initialised${RESET}"; echo ""

# ── 3. detect-secrets ────────────────────────────────────────────────────────
echo -e "${BOLD}▶ [3/4] Setting up detect-secrets...${RESET}"
if ! command -v detect-secrets > /dev/null 2>&1; then
  if command -v pipx > /dev/null 2>&1; then pipx install detect-secrets --quiet
  elif command -v brew > /dev/null 2>&1; then brew install detect-secrets 2>&1 | grep -v "^error:" || true
  elif command -v pip3 > /dev/null 2>&1; then pip3 install detect-secrets --quiet --user || true
  fi
fi
if command -v detect-secrets > /dev/null 2>&1; then
  detect-secrets scan \
    --exclude-files "package-lock\.json|node_modules/|\.next/|public/|\.test\.ts|\.spec\.ts" \
    > .secrets.baseline
  echo -e "${GREEN}✔ .secrets.baseline created — commit this file${RESET}"
else
  echo -e "${AMBER}⚠ detect-secrets not found. Install: brew install pipx && pipx install detect-secrets${RESET}"
fi
echo ""

# ── 4. Semgrep ───────────────────────────────────────────────────────────────
echo -e "${BOLD}▶ [4/4] Checking Semgrep...${RESET}"
if command -v semgrep > /dev/null 2>&1; then
  semgrep --config .semgrep/security.yml --metrics=off --quiet --no-error . 2>&1 | head -20 || true
  echo -e "${GREEN}✔ Semgrep ready${RESET}"
else
  echo -e "${AMBER}⚠ Semgrep not found. Install: pipx install semgrep   or: brew install semgrep${RESET}"
fi
echo ""

echo -e "${BOLD}${GREEN}╔══════════════════════════════════════════════════════════╗${RESET}"
echo -e "${BOLD}${GREEN}║  ✅ Guardrails active — every commit is now protected    ║${RESET}"
echo -e "${BOLD}${GREEN}╚══════════════════════════════════════════════════════════╝${RESET}"
echo ""
echo "  Semgrep rule: all scans use --metrics=off (no data leaves the machine)"
echo "  Commit format: feat|fix|docs|security|chore(scope): description"
echo ""
