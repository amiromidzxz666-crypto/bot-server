// ============================================================
// ماژول ربات تلگرام (سمت سرور Next.js) — نسخه اسکلتی بدون هوش مصنوعی
// با instrumentation.ts موقع بالا آمدن سرور اجرا می‌شود
// قابلیت‌های جدید بعداً طبق دستور مالک به این فایل اضافه می‌شود
// ============================================================
import { readFileSync, writeFileSync } from 'node:fs';
import { getPublicBaseUrl } from './public-url';

export const TOKEN = process.env.TG_MAIN_BOT_TOKEN ?? '';
const API = `https://api.telegram.org/bot${TOKEN}`;
const OWNER_CHAT_ID = process.env.OWNER_TG_CHAT_ID ? Number(process.env.OWNER_TG_CHAT_ID) : 0; // از Secrets
const TG_LIMIT = 4000;

// ---------- متن‌های ربات (بدون هیچ قابلیت هوش مصنوعی) ----------

const WELCOME = `سلام! 👋

🔧 این ربات در حال بازطراحی کامل است و به‌زودی با قابلیت‌های جدید برمی‌گردد.

برای اطلاع از آخرین وضعیت، بعداً دوباره سر بزنید 🙏`;

const UPDATE_NOTE = `🔧 این ربات در حال بازطراحی است و فعلاً قابلیت خاصی ارائه نمی‌دهد.

به‌زودی قابلیت‌های جدید همین‌جا اعلام می‌شود — منتظر خبرها باشید! 🙏`;

const ABOUT_TEXT = `ℹ️ درباره ما

این ربات در حال بازطراحی است و نسخه جدید آن به‌زودی با قابلیت‌های تازه عرضه می‌شود.`;

const START_KEYBOARD = {
  inline_keyboard: [[{ text: 'ℹ️ درباره ما', callback_data: 'about' }]],
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (m: string) => console.log(`[TG-BOT] ${new Date().toISOString()} ${m}`);

async function tg(method: string, params: Record<string, unknown>, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(`${API}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      });
      const data = (await res.json()) as {
        ok: boolean;
        parameters?: { retry_after?: number };
        description?: string;
      };
      if (data.ok) return data;
      const retryAfter = data.parameters?.retry_after;
      if (retryAfter && i < retries) {
        log(`rate limit — ${retryAfter}s صبر می‌کنم`);
        await sleep((retryAfter + 1) * 1000);
        continue;
      }
      log(`خطای تلگرام (${method}): ${data.description ?? '?'}`);
      return null;
    } catch (e) {
      log(`خطای شبکه تلگرام (${method}): ${(e as Error).message}`);
      if (i < retries) await sleep(1500 * (i + 1));
    }
  }
  return null;
}

async function sendMessage(chatId: number, text: string, replyMarkup?: object) {
  const chunks: string[] = [];
  let rest = String(text);
  while (rest.length > TG_LIMIT) {
    let cut = rest.lastIndexOf('\n', TG_LIMIT);
    if (cut < TG_LIMIT * 0.5) cut = TG_LIMIT;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  chunks.push(rest);
  for (const chunk of chunks) {
    await tg('sendMessage', {
      chat_id: chatId,
      text: chunk,
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    });
  }
}

// محدودیت سبک نرخ پیام — سقف 20 پیام در دقیقه برای هر کاربر
const rate = new Map<number, number[]>();
function tooFast(chatId: number) {
  const now = Date.now();
  const arr = (rate.get(chatId) || []).filter((t) => now - t < 60_000);
  arr.push(now);
  rate.set(chatId, arr);
  return arr.length > 20;
}

// ---------- ثبت‌نام کاربران (برای پیام همگانی و آمار) ----------
const USERS_FILE = `${process.env.DATA_DIR ?? '/app/db'}/bot-users.json`;

type SeenUser = { username?: string; first_name?: string; ts: number };
const seenUsers = new Map<string, SeenUser>();

function loadSeenUsers() {
  try {
    const obj = JSON.parse(readFileSync(USERS_FILE, 'utf8')) as Record<string, SeenUser>;
    for (const [k, v] of Object.entries(obj)) seenUsers.set(k, v);
    log(`👥 ${seenUsers.size} کاربر شناخته‌شده لود شد`);
  } catch {
    log('فایل کاربران یافت نشد — از نو ساخته می‌شود');
  }
}

let saveScheduled = false;
function scheduleSaveSeenUsers() {
  if (saveScheduled) return;
  saveScheduled = true;
  setTimeout(() => {
    saveScheduled = false;
    try {
      // ادغام با محتوای فعلی فایل — کاربران قبلی هرگز حذف نمی‌شوند (ضد برگشت داده)
      let obj: Record<string, SeenUser> = {};
      try {
        obj = JSON.parse(readFileSync(USERS_FILE, 'utf8')) as Record<string, SeenUser>;
      } catch {
        /* فایل نیست یا خراب است — از صفر */
      }
      for (const [k, v] of seenUsers.entries()) {
        const ex = obj[k];
        if (!ex || v.ts >= ex.ts) obj[k] = v;
      }
      writeFileSync(USERS_FILE, JSON.stringify(obj, null, 2), 'utf8');
    } catch (e) {
      log(`خطای ذخیره کاربران: ${(e as Error).message}`);
    }
  }, 3000);
}

function registerUser(chatId: number, username?: string, firstName?: string) {
  const key = String(chatId);
  const prev = seenUsers.get(key);
  const now = Math.floor(Date.now() / 1000);
  if (!prev || now - prev.ts > 3600) {
    seenUsers.set(key, { username, first_name: firstName, ts: now });
    scheduleSaveSeenUsers();
  }
}

async function broadcastToAll(text: string): Promise<{ ok: number; fail: number }> {
  let ok = 0;
  let fail = 0;
  for (const key of seenUsers.keys()) {
    const r = await tg('sendMessage', { chat_id: Number(key), text }, 1);
    if (r) ok++;
    else fail++;
    await sleep(80);
  }
  return { ok, fail };
}

// ---------- انواع تلگرام ----------
type TgMsg = {
  chat?: { id?: number; type?: string };
  from?: { is_bot?: boolean; username?: string; first_name?: string };
  date?: number;
  text?: string;
  caption?: string;
};

async function handleMessage(msg: TgMsg) {
  const chatId = msg.chat?.id;
  if (!chatId) return;
  if (msg.from?.is_bot) return;

  // گروه‌ها فعلاً بی‌پاسخ — قابلیت گروهی بعداً طبق دستور مالک اضافه می‌شود
  const isGroup = msg.chat?.type === 'group' || msg.chat?.type === 'supergroup';
  if (isGroup) return;

  const text = (msg.text || msg.caption || '').trim();

  if (tooFast(chatId)) return; // اسپم را بی‌صدا رد کن
  registerUser(chatId, msg.from?.username, msg.from?.first_name);

  if (text === '/start' || text === '/help') {
    await sendMessage(chatId, WELCOME, START_KEYBOARD);
    return;
  }

  // ---------- فرمان‌های مدیر (فقط مالک ربات — ابزار مدیریت، بدون AI) ----------
  if (chatId === OWNER_CHAT_ID && text.startsWith('/broadcast')) {
    const bcText = text.replace(/^\/broadcast\s*/, '').trim();
    if (!bcText) {
      await sendMessage(
        chatId,
        '📢 استفاده:\n/broadcast متن پیام\n\nمتن برای همه کاربران ربات ارسال می‌شود.'
      );
      return;
    }
    await sendMessage(chatId, `📢 در حال ارسال به ${seenUsers.size} کاربر...`);
    const res = await broadcastToAll(bcText);
    await sendMessage(
      chatId,
      `✅ پیام همگانی ارسال شد!\n🎯 موفق: ${res.ok} | ⚠️ ناموفق: ${res.fail}`
    );
    return;
  }
  if (chatId === OWNER_CHAT_ID && text.startsWith('/stats')) {
    const now = Math.floor(Date.now() / 1000);
    const active24h = [...seenUsers.values()].filter((u) => now - u.ts < 86400).length;
    await sendMessage(
      chatId,
      `📊 آمار ربات:\n👥 کل کاربران: ${seenUsers.size}\n🔥 فعال ۲۴ ساعت گذشته: ${active24h}`
    );
    return;
  }

  if (!text) {
    await sendMessage(chatId, 'فعلاً فقط متن را می‌فهمم 🙏');
    return;
  }

  // هر پیام دیگری — پاسخ placeholder (بدون هوش مصنوعی)
  await sendMessage(chatId, UPDATE_NOTE);
}

// ---------- پردازش دکمه‌های شیشه‌ای ----------
type TgCallback = {
  id: string;
  data?: string;
  from?: { is_bot?: boolean; username?: string; first_name?: string };
  message?: { chat?: { id?: number; type?: string }; date?: number };
};

async function handleCallback(cb: TgCallback) {
  const chatId = cb.message?.chat?.id;
  if (!chatId) return;
  if (cb.message?.chat?.type && cb.message.chat.type !== 'private') return;
  registerUser(chatId, cb.from?.username, cb.from?.first_name);

  // همیشه callback را پاس بده تا چرخ‌دنگ دکمه بایستد
  const answer = (text?: string) =>
    tg('answerCallbackQuery', { callback_query_id: cb.id, text }).catch(() => {});

  switch (cb.data) {
    case 'about':
      await answer();
      await sendMessage(chatId, ABOUT_TEXT);
      break;
    case 'start_chat':
    case 'make_image':
    case 'clear_chat':
      // دکمه‌های نسخه قبلی (AI) که هنوز در چت‌های قدیمی موجود است — پاسخ ملایم
      await answer('به‌زودی!');
      await sendMessage(chatId, UPDATE_NOTE);
      break;
    default:
      await answer();
  }
}

// ---------- صف موازی به ازای هر چت ----------
// هم‌چت‌ها ترتیبی پردازش می‌شوند، چت‌های مختلف موازی — polling/webhook هیچ‌وقت بلاک نمی‌شود
const chatQueues = new Map<string, Promise<void>>();

function enqueueChat(chatId: string, task: () => Promise<void>) {
  const prev = chatQueues.get(chatId) ?? Promise.resolve();
  const wrapped = prev
    .catch(() => {})
    .then(task)
    .catch((e) => log(`خطای پردازش: ${(e as Error).message}`))
    .finally(() => {
      if (chatQueues.get(chatId) === wrapped) chatQueues.delete(chatId);
    });
  chatQueues.set(chatId, wrapped);
}

// ---------- پردازش هر آپدیت ----------
type TgUpdate = {
  update_id: number;
  message?: Parameters<typeof handleMessage>[0];
  callback_query?: TgCallback;
};

// پنجره جبران: بعد از بیدار شدن سرور، پیام‌های تا ۶۰ دقیقه پیش هم پاسخ داده می‌شوند
const CATCHUP_MS = 12 * 60 * 60 * 1000; // گیت‌هاب: گپ بین شیفت‌ها جبران می‌شود

function dispatchUpdate(update: TgUpdate) {
  const msg = update.message;
  const cb = update.callback_query;

  if (msg?.chat?.id != null) {
    const date = msg.date ?? 0;
    if (date && date * 1000 < Date.now() - CATCHUP_MS) {
      console.log(
        `[TG-BOT] ${new Date().toISOString()} پیام قدیمی (${Math.round((Date.now() - date * 1000) / 60000)} دقیقه پیش) نادیده گرفته شد`
      );
      return;
    }
    enqueueChat(String(msg.chat.id), () => handleMessage(msg));
  } else if (cb?.message?.chat?.id != null) {
    const date = cb.message.date ?? 0;
    if (date && date * 1000 < Date.now() - CATCHUP_MS) {
      console.log(
        `[TG-BOT] ${new Date().toISOString()} دکمه قدیمی (${Math.round((Date.now() - date * 1000) / 60000)} دقیقه پیش) نادیده گرفته شد`
      );
      return;
    }
    enqueueChat(String(cb.message.chat.id), () => handleCallback(cb));
  }
}

// ورودی وب‌هوک — پلتفرم پیام کاربر را مستقیم به سرور می‌فرستد و سرور را بیدار می‌کند
export function handleWebhookUpdate(update: TgUpdate) {
  dispatchUpdate(update);
}

// ---------- حلقه polling ----------
let offset = 0;
let tgPollErrCount = 0;

async function pollLoop() {
  while (true) {
    try {
      const res = await fetch(
        `${API}/getUpdates?timeout=30&offset=${offset}&allowed_updates=${encodeURIComponent(
          '["message","callback_query"]'
        )}`,
        // تایم‌اوت ایمن: اگر اتصال یخ بزند، حداکثر ۴۰ ثانیه بعد حلقه آزاد می‌شود
        { signal: AbortSignal.timeout(40_000) }
      );
      const data = (await res.json()) as { ok: boolean; result?: TgUpdate[] };
      tgPollErrCount = 0;
      if (data.ok && Array.isArray(data.result)) {
        for (const update of data.result) {
          offset = Math.max(offset, update.update_id + 1);
          dispatchUpdate(update); // موازی به ازای هر چت
        }
      } else {
        await sleep(2500);
      }
    } catch (e) {
      // لاگ محدودشده — اگر polling مدتی صدا نبود، حداقل در لاگ دیده شود
      tgPollErrCount++;
      if (tgPollErrCount === 1 || tgPollErrCount % 20 === 0) {
        console.log(
          `[TG-BOT] ${new Date().toISOString()} خطای polling (${tgPollErrCount} پشت‌سرهم): ${(e as Error)?.message ?? e}`
        );
      }
      await sleep(3000);
    }
  }
}

// ---------- راه‌اندازی ----------
export async function startTelegramBot() {
  loadSeenUsers();

  // ۱) اگر آدرس عمومی تنظیم شده باشد وب‌هوک فعال می‌شود
  const base = getPublicBaseUrl();
  if (base) {
    const res = await tg(
      'setWebhook',
      {
        url: `${base}/api/hooks/telegram/${TOKEN}`,
        allowed_updates: ['message', 'callback_query'],
      },
      1
    );
    if (res) {
      log(`✅ وب‌هوک فعال شد → ${base}/api/hooks/telegram — polling خاموش است`);
      return;
    }
    log('setWebhook ناموفق بود — ادامه با polling');
  }

  // ۲) حالت polling (وقتی آدرس عمومی تنظیم نشده)
  log('✅ ربات روشن شد — long polling شروع شد (نسخه بدون هوش مصنوعی)');
  pollLoop().catch((e) => log(`خطای حلقه polling: ${(e as Error).message}`));

  // اطلاع‌رسانی به کاربر اصلی که ربات آنلاین است (فقط حالت polling)
  setTimeout(() => {
    sendMessage(
      OWNER_CHAT_ID,
      '🤖 ربات روشن شد!\n\n🔧 نسخه جدید در حال آماده‌سازی است — قابلیت‌های جدید به‌زودی فعال می‌شود.'
    ).catch(() => {});
  }, 2000);
}
