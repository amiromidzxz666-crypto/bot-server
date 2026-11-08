// ============================================================
// ربات مدیریت پیام همگانی تلگرام (سمت سرور Next.js)
// ربات شخصی مالک: با یک دکمه، متن را می‌گیرد و به همه گروه‌های
// فعالِ ربات اصلی با توکن ربات اصلی ارسال می‌کند
// ============================================================
import { readFileSync } from 'node:fs';
import { TOKEN as MAIN_TOKEN } from './telegram-bot';

const TOKEN = process.env.TG_ADMIN_BOT_TOKEN ?? '';
const API = `https://api.telegram.org/bot${TOKEN}`;
const MAIN_API = `https://api.telegram.org/bot${MAIN_TOKEN}`;
const OWNER_CHAT_ID = process.env.OWNER_TG_CHAT_ID ? Number(process.env.OWNER_TG_CHAT_ID) : 0; // از Secrets
const GROUPS_FILE = `${process.env.DATA_DIR ?? '/app/db'}/tg-groups.json`;
const TG_LIMIT = 4000;

const WELCOME = `🎛️ سلام رئیس! به پنل مدیریت پیام همگانی خوش اومدی.

با دکمه زیر متن‌ت رو بفرست و به همه گروه‌هایی که ربات اصلی توشون عضوه ارسال کن 📢`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (m: string) => console.log(`[TG-ADMIN] ${new Date().toISOString()} ${m}`);

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
        await sleep((retryAfter + 1) * 1000);
        continue;
      }
      log(`خطای تلگرام (${method}): ${data.description ?? '?'}`);
      return null;
    } catch (e) {
      log(`خطای شبکه (${method}): ${(e as Error).message}`);
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

const MENU_KEYBOARD = {
  inline_keyboard: [[{ text: '📢 پیام همگانی به گروه‌ها', callback_data: 'broadcast' }]],
};

// ---------- لیست گروه‌های فعال ربات اصلی (هر بار از فایل خوانده می‌شود) ----------
function loadGroups(): number[] {
  try {
    const arr = JSON.parse(readFileSync(GROUPS_FILE, 'utf8')) as number[];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

// ---------- ارسال پیام همگانی با ربات اصلی ----------
async function broadcastToGroups(
  text: string
): Promise<{ ok: number; fail: number; total: number }> {
  const groups = loadGroups();
  let ok = 0;
  let fail = 0;
  for (const chatId of groups) {
    const r = await fetch(`${MAIN_API}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
    const data = (await r.json()) as { ok: boolean; description?: string };
    if (data.ok) ok++;
    else {
      fail++;
      log(`ارسال به ${chatId} ناموفق: ${data.description ?? '?'}`);
    }
    await sleep(120); // احترام به محدودیت نرخ تلگرام
  }
  return { ok, fail, total: groups.length };
}

// ---------- حالت‌های مالک ----------
const awaitingBroadcast = new Set<number>(); // مالک در حال نوشتن متن است
const pendingBroadcast = new Map<number, string>(); // متن در انتظار تأیید

const CONFIRM_KEYBOARD = {
  inline_keyboard: [
    [
      { text: '✅ ارسال کن', callback_data: 'send_broadcast' },
      { text: '❌ لغو', callback_data: 'cancel_broadcast' },
    ],
  ],
};

function clearStates(chatId: number) {
  awaitingBroadcast.delete(chatId);
  pendingBroadcast.delete(chatId);
}

// ---------- پردازش پیام ----------
type AdminMsg = {
  chat?: { id?: number; type?: string };
  from?: { is_bot?: boolean; username?: string; first_name?: string };
  date?: number;
  text?: string;
};

async function handleMessage(msg: AdminMsg) {
  const chatId = msg.chat?.id;
  if (!chatId) return;
  if (msg.from?.is_bot) return;

  // فقط مالک — بقیه فقط یک پیام قفل می‌بینند
  if (chatId !== OWNER_CHAT_ID) {
    await sendMessage(chatId, '🔒 این ربات پنل مدیریت شخصی است و فقط برای مالک فعال است.');
    return;
  }

  const text = (msg.text || '').trim();
  if (!text) return;

  if (text === '/start' || text === '/help') {
    clearStates(chatId);
    await sendMessage(chatId, WELCOME, MENU_KEYBOARD);
    return;
  }

  if (text === 'انصراف' || text === '/cancel') {
    const had = awaitingBroadcast.delete(chatId) || pendingBroadcast.delete(chatId);
    await sendMessage(chatId, had ? 'باشه، لغو شد 👌' : 'چیزی برای لغو نبود 😊');
    return;
  }

  // مالک در حال نوشتن متن پیام همگانی است
  if (awaitingBroadcast.has(chatId)) {
    awaitingBroadcast.delete(chatId);
    pendingBroadcast.set(chatId, text);
    const groups = loadGroups();
    await sendMessage(
      chatId,
      `📢 متن پیامت:\n\n« ${text} »\n\n🎯 مقصد: ${groups.length} گروه فعال\n\nارسال کنم؟`,
      CONFIRM_KEYBOARD
    );
    return;
  }

  await sendMessage(chatId, 'برای شروع، دکمه «📢 پیام همگانی به گروه‌ها» رو بزن 👇', MENU_KEYBOARD);
}

// ---------- پردازش دکمه‌ها ----------
type AdminCallback = {
  id: string;
  data?: string;
  from?: { is_bot?: boolean; id?: number };
  message?: { chat?: { id?: number }; date?: number };
};

async function handleCallback(cb: AdminCallback) {
  const chatId = cb.message?.chat?.id;
  if (!chatId || chatId !== OWNER_CHAT_ID) return;

  const answer = (text?: string) =>
    tg('answerCallbackQuery', { callback_query_id: cb.id, text }).catch(() => {});

  switch (cb.data) {
    case 'broadcast': {
      clearStates(chatId);
      await answer('📢 بنویس!');
      const groups = loadGroups();
      if (!groups.length) {
        await sendMessage(
          chatId,
          'هنوز هیچ گروه فعالی ثبت نشده 🤔\nاول تو گروه‌ها به ربات اصلی بگو «فعال» بعد بیا این‌جا.'
        );
        return;
      }
      await sendMessage(
        chatId,
        `📝 متن پیام همگانی رو همین‌جا بنویس و بفرست...\n\n🎯 مقصد: ${groups.length} گروه فعال\n\n(برای لغو بنویس: انصراف)`
      );
      awaitingBroadcast.add(chatId);
      return;
    }
    case 'send_broadcast': {
      const text = pendingBroadcast.get(chatId);
      if (!text) {
        await answer('اول متن پیام رو بفرست!');
        return;
      }
      pendingBroadcast.delete(chatId);
      await answer('در حال ارسال... 🚀');
      const groups = loadGroups();
      log(`همگانی به ${groups.length} گروه | متن: ${text.slice(0, 60).replace(/\n/g, ' ')}`);
      const res = await broadcastToGroups(text);
      await sendMessage(
        chatId,
        res.total
          ? `✅ تمام شد!\n🎯 مقصد: ${res.total} گروه\n✅ موفق: ${res.ok}${res.fail ? `\n⚠️ ناموفق: ${res.fail}` : ''}`
          : 'هیچ گروه فعالی نیست — اول تو گروه‌ها «فعال» بفرست.'
      );
      return;
    }
    case 'cancel_broadcast': {
      clearStates(chatId);
      await answer('لغو شد');
      await sendMessage(chatId, 'باشه، لغو شد 👌');
      return;
    }
    default:
      await answer();
  }
}

// ---------- صف و dispatch (همان الگوی ربات اصلی) ----------
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

type AdminUpdate = {
  update_id: number;
  message?: AdminMsg;
  callback_query?: AdminCallback;
};

// ۶۰ دقیقه — دکمه‌ها و متن‌های فرستاده‌شده موقع خواب سندباکس تا یک ساعت بعد هم جبران می‌شوند
const CATCHUP_MS = 12 * 60 * 60 * 1000; // گیت‌هاب: گپ بین شیفت‌ها جبران می‌شود

function dispatchUpdate(update: AdminUpdate) {
  const msg = update.message;
  const cb = update.callback_query;

  if (msg?.chat?.id != null) {
    const date = msg.date ?? 0;
    if (date && date * 1000 < Date.now() - CATCHUP_MS) {
      log(
        `پیام قدیمی (${Math.round((Date.now() - date * 1000) / 60000)} دقیقه پیش) نادیده گرفته شد`
      );
      return;
    }
    enqueueChat(String(msg.chat.id), () => handleMessage(msg));
  } else if (cb?.message?.chat?.id != null) {
    const date = cb.message.date ?? 0;
    if (date && date * 1000 < Date.now() - CATCHUP_MS) {
      log(
        `دکمه قدیمی (${Math.round((Date.now() - date * 1000) / 60000)} دقیقه پیش) نادیده گرفته شد`
      );
      return;
    }
    enqueueChat(String(cb.message.chat.id), () => handleCallback(cb));
  }
}

// ---------- حلقه polling ----------
let offset = 0;
let adminPollErrCount = 0;

async function pollLoop() {
  while (true) {
    try {
      const res = await fetch(
        `${API}/getUpdates?timeout=30&offset=${offset}&allowed_updates=${encodeURIComponent(
          '["message","callback_query"]'
        )}`,
        // تایم‌اوت ایمن: اتصال یخ‌زده بعد از خواب سندباکس، حداکثر ۴۰ ثانیه بعد حلقه را آزاد می‌کند
        { signal: AbortSignal.timeout(40_000) }
      );
      const data = (await res.json()) as { ok: boolean; result?: AdminUpdate[] };
      adminPollErrCount = 0;
      if (data.ok && Array.isArray(data.result)) {
        for (const update of data.result) {
          offset = Math.max(offset, update.update_id + 1);
          dispatchUpdate(update);
        }
      } else {
        await sleep(2500);
      }
    } catch (e) {
      // لاگ محدودشده — اگر polling مدتی صدا نبود، حداقل در لاگ دیده شود
      adminPollErrCount++;
      if (adminPollErrCount === 1 || adminPollErrCount % 20 === 0) {
        log(`خطای polling (${adminPollErrCount} پشت‌سرهم): ${(e as Error)?.message ?? e}`);
      }
      await sleep(3000);
    }
  }
}

// ---------- راه‌اندازی ----------
export async function startTelegramAdminBot() {
  log('✅ ربات مدیریت پیام همگانی روشن شد (@HmganBot)');
  pollLoop().catch((e) => log(`خطای حلقه polling: ${(e as Error).message}`));

  // اطلاع‌رسانی به مالک
  setTimeout(() => {
    sendMessage(
      OWNER_CHAT_ID,
      '🎛️ پنل مدیریت پیام همگانی آنلاین شد!\n\nبا دکمه زیر هر متنی بنویسی، به همه گروه‌های فعال ربات اصلی ارسال می‌شه 📢',
      MENU_KEYBOARD
    ).catch(() => {});
  }, 2000);
}
