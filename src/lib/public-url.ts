// ============================================================
// خواندن آدرس عمومی سرور برای فعال‌سازی وب‌هوک ربات‌ها
// ترتیب: متغیر محیطی PUBLIC_BASE_URL → فایل db/webhook-base-url.txt
// اگر هیچ‌کدام نبود، ربات‌ها با polling معمولی کار می‌کنند
// ============================================================
import { readFileSync } from 'node:fs';

const URL_FILE = `${process.env.DATA_DIR ?? '/app/db'}/webhook-base-url.txt`;

export function getPublicBaseUrl(): string {
  const fromEnv = (process.env.PUBLIC_BASE_URL || '').trim();
  if (fromEnv.startsWith('https://')) return fromEnv.replace(/\/+$/, '');
  try {
    const fromFile = readFileSync(URL_FILE, 'utf8').trim();
    if (fromFile.startsWith('https://')) return fromFile.replace(/\/+$/, '');
  } catch {
    /* فایل هنوز ساخته نشده — حالت polling */
  }
  return '';
}
