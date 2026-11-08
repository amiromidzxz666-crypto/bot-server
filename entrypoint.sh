#!/bin/bash
set -e
DATA_DIR="${DATA_DIR:-/app/db}"
mkdir -p "$DATA_DIR"

echo "[entrypoint] boot at $(date -u '+%Y-%m-%d %H:%M:%S')"

# ---------- ۱) بازگردانی وضعیت از دیتاست HF (فقط اگر خالی باشد) ----------
if [ ! -s "$DATA_DIR/bot-users.json" ] && [ -n "${HF_TOKEN:-}" ] && [ -n "${HF_DATA_REPO:-}" ]; then
  echo "[entrypoint] restoring state from dataset $HF_DATA_REPO ..."
  for f in bot-users.json tg-groups.json rubika-users.json soroush-users.json custom.db; do
    curl -fsSL --max-time 60 -H "Authorization: Bearer ${HF_TOKEN}" \
      "https://huggingface.co/datasets/${HF_DATA_REPO}/resolve/main/db/${f}" \
      -o "$DATA_DIR/$f" 2>/dev/null \
      || { echo "[entrypoint] restore miss: $f"; rm -f "$DATA_DIR/$f"; }
  done
  echo "[entrypoint] restore done"
fi

# ---------- ۲) دیتابیس پرایما (اگر وجود ندارد) ----------
if [ ! -f "$DATA_DIR/custom.db" ]; then
  echo "[entrypoint] prisma db push ..."
  bunx prisma db push --skip-generate >/dev/null 2>&1 \
    || echo "[entrypoint] prisma db push failed (continuing anyway)"
fi

# ---------- ۳) پینگ خودکار به آدرس عمومی خود اسپیس ----------
# هر ۵ دقیقه یک درخواست به /api/health خودش می‌زند تا اسپیس بعد از ۴۸ ساعت
# بی‌کاری به خواب نرود و ربات‌ها دائمی روشن بمانند
(
  while true; do
    sleep 300
    curl -fsS --max-time 20 "https://${SPACE_ID//\//-}.hf.space/api/health" >/dev/null 2>&1 || true
  done
) &

# ---------- ۴) بکاپ خودکار وضعیت هر ۱۰ دقیقه ----------
(
  while true; do
    sleep 600
    /usr/local/bin/backup.sh || true
  done
) &

# ---------- ۵) اجرای سرور ----------
exec "$@"
