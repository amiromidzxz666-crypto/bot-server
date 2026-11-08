#!/bin/bash
# اجرای ۲ ربات تلگرام به مدت ~۴.۷ ساعت + بکاپ رمزنگاری‌شده وضعیت + dispatch ران بعدی
set -e
cd "$GITHUB_WORKSPACE"

export DATA_DIR="$GITHUB_WORKSPACE/db"
export DATABASE_URL="file:$DATA_DIR/custom.db"
export NODE_ENV=production
mkdir -p "$DATA_DIR"

echo "=== guard: ران موازی دیگر فعال است؟ ==="
ME="${GITHUB_RUN_ID:-0}"
OTHERS=$(gh run list --workflow=bots.yml --status in_progress --json databaseId \
  --jq "[.[] | select(.databaseId != $ME)] | length" 2>/dev/null || echo 0)
if [ "${OTHERS:-0}" -gt 0 ]; then
  echo "ران دیگری فعال است — خروج (این فقط پشتیبانِ زمان‌بند بود)"
  exit 0
fi

echo "=== ۱) بازیابی وضعیت رمزنگاری‌شده ==="
shopt -s nullglob
for f in state/*.enc; do
  name="$(basename "$f" .enc)"
  if openssl enc -d -aes-256-cbc -pbkdf2 -in "$f" -out "$DATA_DIR/$name" -pass env:STATE_KEY 2>/dev/null; then
    echo "restored: $name"
  else
    echo "RESTORE FAILED: $name (حذف می‌شود)"
    rm -f "$DATA_DIR/$name"
  fi
done
ls -la "$DATA_DIR" || true

echo "=== ۲) نصب و ساخت ==="
bun install
bunx prisma generate
echo "=== prisma db push — بروزرسانی اسکیمای دیتابیس روی db بازیابی‌شده (بدون از دست دادن داده) ==="
bunx prisma db push --skip-generate || echo "!! db push ناموفق — ادامه با اسکیمای فعلی"
bun run build

echo "=== ۳) اجرای سرور + ۲ ربات تلگرام ==="
SERVER_PID=0
start_server() {
  NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0 bun .next/standalone/server.js > server.log 2>&1 &
  SERVER_PID=$!
}
start_server
UP=0
for i in $(seq 1 45); do
  if curl -sf http://127.0.0.1:3000/api/health >/dev/null 2>&1; then UP=1; break; fi
  sleep 2
done
[ "$UP" = "1" ] && echo "سرور بالا آمد" || { echo "!! سرور بالا نیامد — server.log:"; tail -30 server.log; exit 1; }

# --- تشخیص‌گر: وضعیت استارت ربات‌ها بلافاصله بعد از بالا آمدن سرور در لاگ اکشن چاپ می‌شود ---
sleep 8
echo "--- getMe چک توکن‌ها (secrets خودکار ماسک می‌شوند) ---"
echo -n "main:  "; curl -s -m 10 "https://api.telegram.org/bot${TG_MAIN_BOT_TOKEN}/getMe" | head -c 220; echo
echo -n "admin: "; curl -s -m 10 "https://api.telegram.org/bot${TG_ADMIN_BOT_TOKEN}/getMe" | head -c 220; echo
echo "--- استارت ربات‌ها در server.log ---"
grep -aE '\[BOTS\]|\[TG-BOT\]|\[TG-ADMIN\]|\[GUARD\]|long polling|خطا|Error|error' server.log | head -30 || true
echo "--- ۱۰ خط آخر server.log ---"
tail -10 server.log || true

git config user.name "state-backup-bot"
git config user.email "actions@users.noreply.github.com"

backup_state() {
  mkdir -p state
  for f in bot-users.json tg-groups.json rubika-users.json soroush-users.json custom.db; do
    [ -s "$DATA_DIR/$f" ] && openssl enc -aes-256-cbc -pbkdf2 \
      -in "$DATA_DIR/$f" -out "state/$f.enc" -pass env:STATE_KEY 2>/dev/null || true
  done
  git add state >/dev/null 2>&1 || true
  if ! git diff --cached --quiet; then
    git commit -m "state backup $(date -u '+%Y-%m-%d %H:%M:%S')" >/dev/null 2>&1 || true
    git pull --rebase origin main >/dev/null 2>&1 || true
    if git push origin HEAD:main >/dev/null 2>&1; then
      echo "[backup] pushed $(date -u '+%H:%M:%S')"
    else
      echo "[backup] push failed — دفعه بعد دوباره"
    fi
  fi
}

FAILS=0
LAST_BACKUP=$(date +%s)
END=$(( $(date +%s) + 282*60 ))
echo "=== ۴) حلقه نگه‌داری تا $((282)) دقیقه دیگر ==="
while [ "$(date +%s)" -lt "$END" ]; do
  sleep 20
  if curl -sf http://127.0.0.1:3000/api/health >/dev/null 2>&1; then
    FAILS=0
  else
    FAILS=$((FAILS+1))
    echo "health fail $FAILS"
    if [ "$FAILS" -ge 6 ]; then
      echo "سرور مرده بود — ری‌استارت..."
      kill "$SERVER_PID" 2>/dev/null || true
      pkill -f "standalone/server.js" 2>/dev/null || true
      sleep 3
      start_server
      FAILS=0
    fi
  fi
  NOW=$(date +%s)
  if [ $((NOW - LAST_BACKUP)) -ge 1800 ]; then
    backup_state
    LAST_BACKUP=$NOW
    # --- تشخیص‌گر دوره‌ای: ربات‌ها هنوز زنده‌اند؟ ---
    TGE=$(grep -acE '\[TG-BOT\].*(خطا|Error|error|409|Conflict)' server.log 2>/dev/null || echo 0)
    echo "[diag] خطاهای TG-BOT تا این لحظه: $TGE"
  fi
done

echo "=== ۵) پایان شیفت — بکاپ نهایی و dispatch ران بعدی ==="
backup_state || true
gh api "repos/$GITHUB_REPOSITORY/actions/workflows/bots.yml/dispatches" -f ref="${GITHUB_REF_NAME:-main}" \
  && echo "ران بعدی dispatch شد" || echo "!! dispatch ناموفق"
sleep 60
echo "شیفت تمام شد"
