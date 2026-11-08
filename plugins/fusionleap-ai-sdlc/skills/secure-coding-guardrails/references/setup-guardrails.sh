#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# FusionLeap Digital — Secure Coding Guardrails Setup
# Run once after the hook files exist (.husky/pre-commit, .husky/commit-msg).
# It installs tools and activates the hooks; it never overwrites them.
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
npm install --save-dev husky@^9 lint-staged prettier
echo -e "${GREEN}✔ npm packages installed${RESET}"; echo ""

# ── 2. Husky ─────────────────────────────────────────────────────────────────
# `husky` (not `husky init`) only points git at .husky/; init would replace
# .husky/pre-commit with its own "npm test" hook.
echo -e "${BOLD}▶ [2/4] Activating Husky hooks...${RESET}"
for hook in pre-commit commit-msg; do
  if [ ! -f ".husky/$hook" ]; then
    echo -e "${AMBER}⚠ .husky/$hook is missing — create it before running this script.${RESET}"
    exit 1
  fi
done
npx husky
chmod +x .husky/pre-commit .husky/commit-msg
echo -e "${GREEN}✔ Hooks active (git core.hooksPath = $(git config core.hooksPath))${RESET}"; echo ""

# ── 3. detect-secrets ────────────────────────────────────────────────────────
echo -e "${BOLD}▶ [3/4] Setting up detect-secrets...${RESET}"
if ! command -v detect-secrets > /dev/null 2>&1; then
  if command -v pipx > /dev/null 2>&1; then pipx install detect-secrets
  elif command -v brew > /dev/null 2>&1; then brew install detect-secrets || true
  elif command -v pip3 > /dev/null 2>&1; then pip3 install --user detect-secrets || true
  fi
fi
if command -v detect-secrets > /dev/null 2>&1; then
  # The baseline stores these settings; the hook reads them from it.
  detect-secrets scan \
    --exclude-files 'package-lock\.json|yarn\.lock|pnpm-lock\.yaml|node_modules/|\.next/|dist/|\.env\.example' \
    > .secrets.baseline
  echo -e "${GREEN}✔ .secrets.baseline created — review it, then commit it${RESET}"
else
  echo -e "${AMBER}⚠ detect-secrets not found. Install: pipx install detect-secrets${RESET}"
fi
echo ""

# ── 4. Semgrep ───────────────────────────────────────────────────────────────
echo -e "${BOLD}▶ [4/4] Checking Semgrep...${RESET}"
if command -v semgrep > /dev/null 2>&1; then
  echo "  Current findings across the repo (not blocking):"
  semgrep --config .semgrep/security.yml --metrics=off --quiet . 2>&1 | head -40 || true
  echo -e "${GREEN}✔ Semgrep ready${RESET}"
else
  echo -e "${AMBER}⚠ Semgrep not found. Install: pipx install semgrep   or: brew install semgrep${RESET}"
fi
echo ""

echo -e "${BOLD}${GREEN}╔══════════════════════════════════════════════════════════╗${RESET}"
echo -e "${BOLD}${GREEN}║  ✅ Guardrails active — every commit is now checked      ║${RESET}"
echo -e "${BOLD}${GREEN}╚══════════════════════════════════════════════════════════╝${RESET}"
echo ""
echo "  Semgrep runs with --metrics=off (no usage data leaves the machine)"
echo "  Commit format: feat|fix|docs|security|chore(scope): description"
echo ""
