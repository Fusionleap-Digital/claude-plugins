#!/usr/bin/env sh
. "$(dirname "$0")/_/husky.sh"

echo ""
echo "╔══════════════════════════════════════════════════╗"
echo "║  FusionLeap · Secure Coding Guardrails 🔒        ║"
echo "╚══════════════════════════════════════════════════╝"
echo ""

# ── 1. Lint + format staged files ────────────────────────────────────────────
echo "▶ [1/4] Linting staged files..."
npx lint-staged
if [ $? -ne 0 ]; then
  echo "✖ Lint/format failed. Fix the issues above before committing."
  exit 1
fi
echo "✔ Lint passed"
echo ""

# ── 2. Run unit tests ─────────────────────────────────────────────────────────
echo "▶ [2/4] Running unit tests..."
npm test
if [ $? -ne 0 ]; then
  echo "✖ Tests failed. Fix failing tests before committing."
  exit 1
fi
echo "✔ Tests passed"
echo ""

# ── 3. Secret scanning (detect-secrets) ──────────────────────────────────────
echo "▶ [3/4] Scanning for hardcoded secrets..."
if command -v detect-secrets-hook > /dev/null 2>&1; then
  git diff --cached --name-only | xargs detect-secrets-hook --baseline .secrets.baseline 2>&1
  if [ $? -ne 0 ]; then
    echo ""
    echo "✖ Potential secrets detected in staged files!"
    echo "  → If these are false positives, run:"
    echo "      detect-secrets scan > .secrets.baseline"
    echo "  → Re-stage .secrets.baseline and commit again."
    exit 1
  fi
  echo "✔ No secrets detected"
else
  echo "⚠ detect-secrets not installed — skipping. Run: pip install detect-secrets"
fi
echo ""

# ── 4. Semgrep security scan ──────────────────────────────────────────────────
echo "▶ [4/4] Semgrep security scan..."
if command -v semgrep > /dev/null 2>&1; then
  STAGED_FILES=$(git diff --cached --name-only --diff-filter=ACM | grep -E '\.(ts|tsx|js|jsx)$')
  if [ -n "$STAGED_FILES" ]; then
    # --metrics=off: no usage data leaves the machine
    echo "$STAGED_FILES" | xargs semgrep --config .semgrep/security.yml --metrics=off --error --quiet 2>&1
    if [ $? -ne 0 ]; then
      echo ""
      echo "✖ Semgrep found security issues in staged files."
      echo "  Review the findings above before committing."
      exit 1
    fi
    echo "✔ Semgrep passed"
  else
    echo "✔ No .ts/.tsx/.js files staged — skipping Semgrep"
  fi
else
  echo "⚠ Semgrep not installed — skipping. Run: pip install semgrep"
fi
echo ""

echo "╔══════════════════════════════════════════════════╗"
echo "║  ✅ All guardrails passed — committing           ║"
echo "╚══════════════════════════════════════════════════╝"
echo ""
