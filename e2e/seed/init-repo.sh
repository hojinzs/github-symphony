#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="/e2e/repos/test-owner/test-repo"
mkdir -p "$REPO_DIR"
cd "$REPO_DIR"

git init --initial-branch=main
git config user.email "e2e@test.local"
git config user.name "E2E Test"

cp /e2e/seed/WORKFLOW.md WORKFLOW.md
git add WORKFLOW.md
git commit -m "Initial commit with WORKFLOW.md"
