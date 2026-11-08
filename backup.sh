#!/bin/bash
# بکاپ فایل‌های وضعیت به دیتاست خصوصی HF (فراخوانی‌شده توسط entrypoint)
DATA_DIR="${DATA_DIR:-/app/db}"
[ -n "${HF_TOKEN:-}" ] && [ -n "${HF_DATA_REPO:-}" ] || exit 0
REPO_DIR="/tmp/data-repo"
URL="https://oauth2:${HF_TOKEN}@huggingface.co/datasets/${HF_DATA_REPO}"

if [ ! -d "$REPO_DIR/.git" ]; then
  rm -rf "$REPO_DIR"
  git clone --depth 1 "$URL" "$REPO_DIR" >/dev/null 2>&1 || { echo "[backup] clone failed"; exit 1; }
fi
cd "$REPO_DIR" || exit 1
git pull --rebase >/dev/null 2>&1 || true

mkdir -p db
cp -f "$DATA_DIR/bot-users.json" "$DATA_DIR/tg-groups.json" \
      "$DATA_DIR/rubika-users.json" "$DATA_DIR/soroush-users.json" \
      "$DATA_DIR/custom.db" db/ 2>/dev/null

git config user.email "bot@local"
git config user.name "state-backup"
git add -A db
if git diff --cached --quiet; then exit 0; fi
git commit -m "state backup $(date -u '+%Y-%m-%d %H:%M:%S')" >/dev/null
if git push >/dev/null 2>&1; then
  echo "[backup] pushed at $(date -u '+%Y-%m-%d %H:%M:%S')"
else
  echo "[backup] push failed (will retry next cycle)"
fi
