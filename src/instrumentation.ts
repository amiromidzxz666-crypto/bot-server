// ============================================================
// Next.js Instrumentation — موقع استارت سرور اجرا می‌شود
// هر سه چت‌بات (تلگرام + روبیکا + سروش پلاس) را داخل پروسه سرور راه‌اندازی می‌کند
// ============================================================
export async function register() {
  // فقط در ران‌تایم Node.js سمت سرور
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  // کلید اضطراری: اگر فایل پرچم وجود داشته باشد ربات‌ها استارت نمی‌شوند (فقط وب‌سرور بالا می‌آید)
  // کاربرد: وقتی ربات‌ها روی سرور دیگری (مثل Hugging Face) اجرا می‌شوند، این نسخه نباید polling کند
  // وگرنه تلگرام خطای 409 Conflict می‌دهد و پیام‌ها بین دو نسخه گم می‌شوند
  try {
    const { existsSync } = await import('node:fs');
    if (
      existsSync(
        `${process.env.DATA_DIR ?? '/app/db'}/bots-disabled.flag`,
      )
    ) {
      console.log(
        '[BOTS] پرچم bots-disabled فعال است — ربات‌ها استارت نشدند (حالت وب‌سرور فقط)',
      );
      return;
    }
  } catch {
    /* دسترسی فایل نبود — ادامه عادی */
  }

  // جلوگیری از اجرای چندباره (HMR / هات ریلود)
  const g = globalThis as unknown as { __BOTS_STARTED?: boolean };
  if (g.__BOTS_STARTED) return;
  g.__BOTS_STARTED = true;

  // شبکه ایمنی سراسری — یک خطای پراکنده نباید کل سرور (و همه ربات‌ها) را بکشد
  process.on('unhandledRejection', (reason) => {
    console.error('[GUARD] unhandledRejection:', reason);
  });
  process.on('uncaughtException', (err) => {
    console.error('[GUARD] uncaughtException:', (err as Error)?.stack ?? err);
  });

  // (watchdog سندباکس اینجا لازم نیست — entrypoint.sh نگه‌داری را انجام می‌دهد)

  // انتخاب ربات‌ها — BOTS_ENABLED مثل "tg,admin" فقط همان‌ها را استارت می‌کند
  // پیش‌فرض «all» = همه ربات‌ها (رفتار سندباکس مثل قبل)
  // کلیدها: tg = چت‌بات تلگرام، rb = روبیکا، sp = سروش پلاس، admin = پیام همگانی
  const enabledBots = (process.env.BOTS_ENABLED ?? 'all')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const wantBot = (key: string) =>
    enabledBots.includes('all') || enabledBots.includes(key);

  if (wantBot('tg')) {
    try {
      const { startTelegramBot } = await import('./lib/telegram-bot');
      startTelegramBot();
    } catch (e) {
      console.error('[TG-BOT] خطای راه‌اندازی:', (e as Error).message);
    }
  }

  if (wantBot('rb')) {
    try {
      const { startRubikaBot } = await import('./lib/rubika-bot');
      startRubikaBot();
    } catch (e) {
      console.error('[RB-BOT] خطای راه‌اندازی:', (e as Error).message);
    }
  }

  if (wantBot('sp')) {
    try {
      const { startSoroushBot } = await import('./lib/soroush-bot');
      startSoroushBot();
    } catch (e) {
      console.error('[SP-BOT] خطای راه‌اندازی:', (e as Error).message);
    }
  }

  if (wantBot('admin')) {
    try {
      const { startTelegramAdminBot } = await import('./lib/telegram-admin-bot');
      startTelegramAdminBot();
    } catch (e) {
      console.error('[TG-ADMIN] خطای راه‌اندازی:', (e as Error).message);
    }
  }

  // keep-alive داخلی — سرور و روت‌ها گرم می‌مانند تا بعد از بیداری سریع پاسخ بدهند
  setInterval(() => {
    fetch('http://127.0.0.1:3000/api/health').catch(() => {});
  }, 60_000);
}
