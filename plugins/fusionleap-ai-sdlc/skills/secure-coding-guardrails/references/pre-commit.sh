# FusionLeap · Secure Coding Guardrails — pre-commit hook (Husky v9: plain shell, no shim)

echo ""
echo "╔══════════════════════════════════════════════════╗"
echo "║  FusionLeap · Secure Coding Guardrails 🔒        ║"
echo "╚══════════════════════════════════════════════════╝"
echo ""

# ── 1. Lint + format staged files ────────────────────────────────────────────
echo "▶ [1/4] Linting staged files..."
if ! npx lint-staged; then
  echo "✖ Lint/format failed. Fix the issues above before committing."
  exit 1
fi
echo "✔ Lint passed"
echo ""

# ── 2. Type check ─────────────────────────────────────────────────────────────
echo "▶ [2/4] Type checking..."
if grep -q '"typecheck"' package.json 2>/dev/null; then
  if ! npm run --silent typecheck; then
    echo "✖ Type errors found. Fix them before committing."
    exit 1
  fi
  echo "✔ Types passed"
else
  echo "⚠ No \"typecheck\" script in package.json — skipping."
fi
echo ""

# ── 3. Secret scanning (detect-secrets) ──────────────────────────────────────
echo "▶ [3/4] Scanning for hardcoded secrets..."
if command -v detect-secrets-hook > /dev/null 2>&1; then
  STAGED_ALL=$(git diff --cached --name-only --diff-filter=ACM)
  if [ -n "$STAGED_ALL" ]; then
    if ! echo "$STAGED_ALL" | tr '\n' '\0' | xargs -0 detect-secrets-hook --baseline .secrets.baseline; then
      echo ""
      echo "✖ Potential secrets detected in staged files!"
      echo "  → Remove the secret and use an environment variable instead."
      echo "  → If it is a false positive, mark the line with: # pragma: allowlist secret"
      echo "    or refresh the baseline: detect-secrets scan --baseline .secrets.baseline"
      exit 1
    fi
  fi
  echo "✔ No secrets detected"
else
  echo "⚠ detect-secrets not installed — skipping. Install: pipx install detect-secrets"
fi
echo ""

# ── 4. Semgrep security scan ──────────────────────────────────────────────────
# Scans from the repo root so the rules' path filters (e.g. app/api/) apply, and
# --baseline-commit reports only findings that are new since the last commit.
echo "▶ [4/4] Semgrep security scan..."
if command -v semgrep > /dev/null 2>&1; then
  if git diff --cached --name-only --diff-filter=ACM | grep -qE '\.(ts|tsx|js|jsx|mjs|cjs)$'; then
    BASELINE=""
    git rev-parse --verify -q HEAD > /dev/null && BASELINE="--baseline-commit HEAD"
    # --metrics=off: no usage data leaves the machine.
    # ERROR findings block the commit; WARNING findings are shown but don't.
    # Husky runs hooks with `sh -e`, so capture the exit code instead of letting it abort.
    SEMGREP_EXIT=0
    semgrep --config .semgrep/security.yml --metrics=off --severity ERROR --error --quiet $BASELINE . || SEMGREP_EXIT=$?
    if [ $SEMGREP_EXIT -eq 1 ]; then
      echo ""
      echo "✖ Semgrep found security issues in your changes."
      echo "  Review the findings above before committing."
      exit 1
    elif [ $SEMGREP_EXIT -ne 0 ]; then
      echo ""
      echo "✖ Semgrep could not run (exit $SEMGREP_EXIT). Check the rules with:"
      echo "    semgrep --validate --config .semgrep/security.yml --metrics=off"
      exit 1
    fi
    semgrep --config .semgrep/security.yml --metrics=off --severity WARNING --quiet $BASELINE . || true
    echo "✔ Semgrep passed"
  else
    echo "✔ No JS/TS files staged — skipping Semgrep"
  fi
else
  echo "⚠ Semgrep not installed — skipping. Install: pipx install semgrep"
fi
echo ""

echo "╔══════════════════════════════════════════════════╗"
echo "║  ✅ All guardrails passed — committing           ║"
echo "╚══════════════════════════════════════════════════╝"
echo ""
