// ============================================================
// ماژول چت‌بات هوشمند سروش پلاس (سمت سرور Next.js)
// با instrumentation.ts موقع بالا آمدن سرور اجرا می‌شود
// API: https://api.splus.ir/bot{TOKEN} — کلون هم‌ساختار Bot API تلگرام
// کشفیات تست واقعی (اسکریپت‌های probe-splus*.sh):
//   - sendMessage/sendPhoto/sendChatAction/answerCallbackQuery/editMessageText موجودند
//   - reply_markup با inline_keyboard پشتیبانی می‌شود (اعتبارسنجی سمت سرور دارد)
//   - sendPhoto هم multipart می‌پذیرد هم URL عکس
//   - setMyDescription وجود ندارد؛ بقیه مثل تلگرام است
// ============================================================
import { readFileSync, writeFileSync } from 'node:fs';
import ZAI from './zai-shim';
import { getPublicBaseUrl } from './public-url';

export const TOKEN = process.env.SOROUSH_BOT_TOKEN ?? '';
const API = `https://api.splus.ir/bot${TOKEN}`;
const OWNER_USERNAME = process.env.SOROUSH_OWNER_USERNAME ?? ''; // از Secrets
let OWNER_CHAT_ID = process.env.SOROUSH_OWNER_CHAT_ID ?? ''; // از Secrets
const CHUNK_LIMIT = 3500;
const MAX_HISTORY = 20;
const HTTP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

// ---------- متن‌های ربات ----------
const SYSTEM_PROMPT = `تو یک دستیار چت هوشمند و صمیمی هستی که داخل یک ربات سروش پلاس به کاربر فارسی‌زبان پاسخ می‌دهی.

ویژگی‌هایت:
- گرم، خودمانی و دوستانه حرف می‌زنی و از ایموجی‌های مناسب و به‌جا استفاده می‌کنی.
- به هر سوالی جواب می‌دهی: عمومی، علمی، فنی، سرگرمی، ترجمه، نویسندگی خلاقانه و...
- جواب‌هایت را برای سروش پلاس مناسب می‌سازی: کوتاه تا متوسط، بدون فرمت markdown پیچیده — فقط متن ساده با خطوط جدید.
- اگر سوال مبهم بود، یک جمله سوال شفاف‌سازی می‌پرسی.
- اگر جواب بلند شد، آن را مرتب و خوانا با خطوط جدا کن.
- همیشه به همان زبانی جواب می‌دهی که کاربر با آن نوشته (پیش‌فرض: فارسی).
- اطلاعات شخصی کاربر را محترمانه نگه می‌داری.`;

const WELCOME = `سلام! 👋 به چت‌بات هوشمند و رایگان خوش اومدی 🤖✨

💬 باهات گپ می‌زنم و به هر سوالی جواب می‌دم — بدون اینکه از سروش پلاس خارج بشی 😊
🖼️ عکس هم با هوش مصنوعی برات می‌سازم!

از دکمه‌های زیر استفاده کن یا همین‌جا مستقیم بنویس! 👇`;

const ABOUT_TEXT = `ℹ️ درباره ما

این ابزار کاملا رایگان توسعه داده شده برای شما تا رایگان هر چقدر خواستید چت کنید و سوالات تون رو بپرسید بدون اینکه از سروش پلاس خارج بشید♥️`;

const IMAGE_HELP = `🖼️ برای ساخت عکس، توضیحش رو برام بنویس:

/image یک گربه فضایی روی ماه
/عکس خانه‌ای آینده‌نگر زیر باران نئونی

💡 نکته: اگه توی توضیحت «عمودی» یا «افقی» بنویسی، عکس همون‌طور ساخته می‌شه!`;

// ---------- منوی دکمه‌های شیشه‌ای ----------
const START_KEYBOARD = {
  inline_keyboard: [
    [{ text: '🚀 شروع چت', callback_data: 'start_chat' }],
    [
      { text: '🖼️ ساخت عکس', callback_data: 'make_image' },
      { text: '🧹 پاکسازی چت', callback_data: 'clear_chat' },
    ],
    [
      { text: 'ℹ️ درباره ما', callback_data: 'about' },
    ],
  ],
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (m: string) => console.log(`[SP-BOT] ${new Date().toISOString()} ${m}`);

let zai: Awaited<ReturnType<typeof ZAI.create>> | null = null;
async function getZai() {
  if (!zai) zai = await ZAI.create();
  return zai;
}

// ---------- انواع API سروش پلاس ----------
type SpUser = { id?: number; is_bot?: boolean; username?: string; first_name?: string };
type SpMessage = {
  message_id?: number;
  from?: SpUser;
  chat?: { id?: number | string; type?: string };
  date?: number;
  text?: string;
  caption?: string;
};
type SpCallback = {
  id: string;
  data?: string;
  from?: SpUser;
  message?: SpMessage;
};
type SpUpdate = {
  update_id: number;
  message?: SpMessage;
  callback_query?: SpCallback;
};

// ---------- فراخوانی API سروش پلاس ----------
async function sp(method: string, params: Record<string, unknown>, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(`${API}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
        signal: AbortSignal.timeout(40_000),
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
      log(`خطای سروش (${method}): ${data.description ?? '?'}`);
      return null;
    } catch (e) {
      log(`خطای شبکه سروش (${method}): ${(e as Error).message}`);
      if (i < retries) await sleep(1500 * (i + 1));
    }
  }
  return null;
}

async function sendMessage(chatId: string, text: string, replyMarkup?: object): Promise<boolean> {
  const chunks: string[] = [];
  let rest = String(text);
  while (rest.length > CHUNK_LIMIT) {
    let cut = rest.lastIndexOf('\n', CHUNK_LIMIT);
    if (cut < CHUNK_LIMIT * 0.5) cut = CHUNK_LIMIT;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  chunks.push(rest);
  let ok = true;
  for (let i = 0; i < chunks.length; i++) {
    const r = await sp('sendMessage', {
      chat_id: chatId,
      text: chunks[i] || '...',
      ...(replyMarkup && i === 0 ? { reply_markup: replyMarkup } : {}),
    });
    if (!r) ok = false;
  }
  return ok;
}

// ---------- تشخیص مالک (با آیدی سروش پلاس @Hlamat) ----------
function isOwner(chatId: string, username?: string): boolean {
  if (OWNER_CHAT_ID && chatId === OWNER_CHAT_ID) return true;
  if (username && username.toLowerCase() === OWNER_USERNAME.toLowerCase()) {
    if (!OWNER_CHAT_ID) {
      OWNER_CHAT_ID = chatId;
      log(`👑 مالک شناسایی شد: chat_id=${chatId} (@${username})`);
    }
    return true;
  }
  return false;
}

// ---------- حافظه مکالمه به ازای هر چت ----------
const histories = new Map<string, { role: 'user' | 'assistant'; content: string }[]>();

function getHistory(chatId: string) {
  if (!histories.has(chatId)) {
    histories.set(chatId, [{ role: 'assistant', content: SYSTEM_PROMPT }]);
  }
  const h = histories.get(chatId)!;
  if (h.length > MAX_HISTORY + 1) {
    h.splice(1, h.length - MAX_HISTORY - 1); // پرامپت سیستم همیشه حفظ شود
  }
  return h;
}

// ---------- محدودیت سبک نرخ (ربات عمومی است) ----------
const rate = new Map<string, number[]>();
function tooFast(chatId: string) {
  const now = Date.now();
  const arr = (rate.get(chatId) || []).filter((t) => now - t < 60_000);
  arr.push(now);
  rate.set(chatId, arr);
  return arr.length > 20;
}

const imageRate = new Map<string, number[]>();
function imageTooFast(chatId: string) {
  const now = Date.now();
  const arr = (imageRate.get(chatId) || []).filter((t) => now - t < 60_000);
  arr.push(now);
  imageRate.set(chatId, arr);
  return arr.length > 6;
}

// ---------- صف موازی به ازای هر چت ----------
// هم‌چت‌ها ترتیبی پردازش می‌شوند، چت‌های مختلف موازی — polling هیچ‌وقت بلاک نمی‌شود
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

// ---------- ثبت‌نام کاربران (برای پیام همگانی و آمار) ----------
const USERS_FILE = `${process.env.DATA_DIR ?? '/app/db'}/soroush-users.json`;

type SeenUser = { username?: string; first_name?: string; ts: number };
const seenUsers = new Map<string, SeenUser>();

function loadSeenUsers() {
  try {
    const obj = JSON.parse(readFileSync(USERS_FILE, 'utf8')) as Record<string, SeenUser>;
    for (const [k, v] of Object.entries(obj)) seenUsers.set(k, v);
    log(`👥 ${seenUsers.size} کاربر شناخته‌شده سروش لود شد`);
  } catch {
    log('فایل کاربران سروش یافت نشد — از نو ساخته می‌شود');
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

function registerUser(chatId: string, username?: string, firstName?: string) {
  const prev = seenUsers.get(chatId);
  const now = Math.floor(Date.now() / 1000);
  if (!prev || now - prev.ts > 3600) {
    seenUsers.set(chatId, { username, first_name: firstName, ts: now });
    scheduleSaveSeenUsers();
    log(
      `👤 کاربر ${username ? '@' + username : firstName || chatId} ثبت شد (کل: ${seenUsers.size})`
    );
  }
}

async function broadcastToAll(text: string): Promise<{ ok: number; fail: number }> {
  let ok = 0;
  let fail = 0;
  for (const key of seenUsers.keys()) {
    const r = await sendMessage(key, text);
    if (r) ok++;
    else fail++;
    await sleep(150);
  }
  return { ok, fail };
}

// ---------- ساخت تصویر با هوش مصنوعی ----------
const awaitingImage = new Map<string, boolean>();

// تشخیص درخواست ساخت تصویر از متن — null یعنی درخواست عکس نبود، '' یعنی فرمان بدون توضیح
function extractImagePrompt(text: string): string | null {
  const t = text.trim();
  const cmd = t.match(/^\/(image|img|عکس)(\s+([\s\S]+))?$/i);
  if (cmd) return (cmd[3] || '').trim();
  const triggers = [
    'برام عکس بساز',
    'برام تصویر بساز',
    'یه عکس بساز',
    'ی عکس بساز',
    'عکس بساز',
    'تصویر بساز',
  ];
  for (const tr of triggers) {
    if (t.startsWith(tr)) {
      let rest = t.slice(tr.length).trim();
      if (rest.startsWith('از ')) rest = rest.slice(3).trim();
      if (rest.startsWith('یک ')) rest = rest.slice(3).trim();
      return rest;
    }
  }
  return null;
}

// آپلود تصویر روی هاست عمومی — پشتیبان برای وقتی sendPhoto مستقیم شکست خورد
async function hostImage(buffer: Buffer): Promise<string | null> {
  const makeForm = () => {
    const fd = new FormData();
    fd.append('file', new Blob([new Uint8Array(buffer)], { type: 'image/png' }), 'ai-image.png');
    return fd;
  };

  // ۱) x0.at — ماندگاری طولانی برای فایل‌های کوچک
  try {
    const res = await fetch('https://x0.at', {
      method: 'POST',
      body: makeForm(),
      headers: { 'User-Agent': HTTP_UA },
      signal: AbortSignal.timeout(90_000),
    });
    const t = (await res.text()).trim();
    if (t.startsWith('https://')) return t;
    log(`x0.at پاسخ غیرمنتظره: ${t.slice(0, 100)}`);
  } catch (e) {
    log(`خطای آپلود x0.at: ${(e as Error).message}`);
  }

  // ۲) tmpfiles.org — نگهداری ۶۰ دقیقه‌ای (گزینه آخر)
  try {
    const res = await fetch('https://tmpfiles.org/api/v1/upload', {
      method: 'POST',
      body: makeForm(),
      headers: { 'User-Agent': HTTP_UA },
      signal: AbortSignal.timeout(60_000),
    });
    const j = (await res.json()) as { status?: string; data?: { url?: string } };
    if (j?.status === 'success' && j?.data?.url) return j.data.url;
  } catch (e) {
    log(`خطای آپلود tmpfiles: ${(e as Error).message}`);
  }

  return null;
}

async function generateAndSendImage(chatId: string, rawPrompt: string) {
  if (imageTooFast(chatId)) {
    await sendMessage(chatId, '😅 الان زیادی عکس خواستی! یه دقیقه صبر کن، بعد دوباره امتحان کن.');
    return;
  }
  log(`تصویر ${chatId} | پرامپت: ${rawPrompt.slice(0, 80).replace(/\n/g, ' ')}`);

  // نشانگر «در حال ارسال عکس...» تا پایان کار
  let uploading = true;
  (async () => {
    while (uploading) {
      sp('sendChatAction', { chat_id: chatId, action: 'upload_photo' }).catch(() => {});
      await sleep(4500);
    }
  })();

  try {
    const client = await getZai();

    // ۱) تبدیل توضیح فارسی به پرامپت انگلیسی غنی برای کیفیت بهتر
    let prompt = rawPrompt;
    try {
      const tr = await client.chat.completions.create({
        messages: [
          {
            role: 'assistant',
            content:
              "You turn the user's image description into one vivid, concise English prompt for a text-to-image model. Output ONLY the English prompt text — no explanations, no quotes. Preserve style hints (photorealistic, cartoon, anime, etc.). Maximum 60 words.",
          },
          { role: 'user', content: rawPrompt },
        ],
        thinking: { type: 'disabled' },
      });
      const en = tr?.choices?.[0]?.message?.content?.trim();
      if (en && en.length > 2 && en.length < 600) prompt = en;
    } catch {
      /* ترجمه نشد — از توضیح اصلی استفاده کن */
    }

    // ۲) جهت تصویر بر اساس کلمات کلیدی
    let size: '1024x1024' | '768x1344' | '1344x768' = '1024x1024';
    if (/عمودی|پرتره/.test(rawPrompt)) size = '768x1344';
    else if (/افقی|پانوراما|پانورما/.test(rawPrompt)) size = '1344x768';

    // ۳) تولید تصویر
    const gen = await client.images.generations.create({ prompt, size });
    const b64 = gen?.data?.[0]?.base64;
    if (!b64) throw new Error('پاسخ تصویر خالی بود');
    const buffer = Buffer.from(b64, 'base64');
    log(`تصویر تولید شد (${size}، ${(buffer.length / 1024).toFixed(0)}KB) — در حال ارسال...`);

    const caption = `🖼️ عکس ساخته شد! ✨\n📝 توضیح شما: ${rawPrompt.slice(0, 200)}`;

    // ۴) ارسال مستقیم با sendPhoto multipart
    const form = new FormData();
    form.append('chat_id', chatId);
    form.append('caption', caption);
    form.append('photo', new Blob([new Uint8Array(buffer)], { type: 'image/png' }), 'ai-image.png');
    const up = await fetch(`${API}/sendPhoto`, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(120_000),
    });
    const upData = (await up.json()) as { ok: boolean; description?: string };
    if (upData.ok) {
      log(`تصویر ${chatId} مستقیم ارسال شد (${size})`);
      return;
    }
    log(`sendPhoto مستقیم ناموفق: ${upData.description} — تلاش با هاست عمومی...`);

    // ۵) پشتیبان: آپلود روی x0.at و ارسال با URL
    const url = await hostImage(buffer);
    if (!url) throw new Error('آپلود تصویر روی هاست ناموفق بود');
    const r2 = await sp('sendPhoto', { chat_id: chatId, photo: url, caption });
    if (r2) {
      log(`تصویر ${chatId} با لینک ارسال شد → ${url}`);
      return;
    }

    // ۶) آخرین راه: ارسال لینک متنی
    await sendMessage(
      chatId,
      `🖼️ عکس ساخته شد! ✨\n\n📝 توضیح شما: ${rawPrompt.slice(0, 200)}\n\n🔗 دیدن و دانلود عکس (روی لینک بزن):\n${url}\n\n💡 برای عکس بعدی بنویس: عکس ... بساز`
    );
    log(`تصویر ${chatId} به‌صورت لینک متنی ارسال شد → ${url}`);
  } catch (e) {
    const em = (e as Error).message || '';
    log(`خطای تولید تصویر: ${em}`);
    const filtered = /contentFilter|1301|sensitive/i.test(em);
    await sendMessage(
      chatId,
      filtered
        ? '🚫 این توضیح به‌خاطر قوانین محتوایی سرویسِ ساخت عکس قابل اجرا نیست.\nلطفاً موضوع دیگه‌ای بخواه یا کلمات رو عوض کن 🙏'
        : '😖 متاسفانه ساخت عکس این بار ناموفق بود. لطفاً دوباره امتحان کن یا توضیحت رو ساده‌تر بنویس 🙏'
    ).catch(() => {});
  } finally {
    uploading = false;
  }
}

// پاکسازی پاسخ مدل: بلوک <think> و تگ‌های جا‌افتاده حذف شود
function cleanReply(t: string): string {
  return t
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<\/?think>/gi, '')
    .trim();
}

async function handleMessage(msg: SpMessage) {
  const chatId = String(msg.chat?.id ?? '');
  if (!chatId) return;
  if (msg.from?.is_bot) return;
  if (tooFast(chatId)) return; // اسپم را بی‌صدا رد کن
  registerUser(chatId, msg.from?.username, msg.from?.first_name);
  const owner = isOwner(chatId, msg.from?.username);

  const text = (msg.text || msg.caption || '').trim();

  if (!text) {
    if (awaitingImage.get(chatId)) {
      await sendMessage(chatId, '🖼️ برای ساخت عکس، توضیحش رو متنی برام بنویس...');
    } else {
      await sendMessage(chatId, 'الان فقط متن رو می‌فهمم 🙏 اگه چیزی دوست داری، برام بنویس! 😊');
    }
    return;
  }

  if (text === '/start' || text === '/help') {
    histories.set(chatId, [{ role: 'assistant', content: SYSTEM_PROMPT }]);
    awaitingImage.delete(chatId);
    await sendMessage(chatId, WELCOME, START_KEYBOARD);
    return;
  }
  if (text === '/new' || text === '/clear') {
    histories.set(chatId, [{ role: 'assistant', content: SYSTEM_PROMPT }]);
    awaitingImage.delete(chatId);
    await sendMessage(chatId, '🧹 حافظه مکالمه پاک شد! از نو شروع کنیم 😄');
    return;
  }

  // ---------- فرمان‌های مدیر (فقط مالک ربات) ----------
  if (owner && text.startsWith('/broadcast')) {
    const bcText = text.replace(/^\/broadcast\s*/, '').trim();
    if (!bcText) {
      await sendMessage(
        chatId,
        '📢 استفاده:\n/broadcast متن پیام\n\nمتن برای همه کاربران سروش پلاسِ ربات ارسال می‌شود.'
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
  if (owner && text.startsWith('/stats')) {
    const now = Math.floor(Date.now() / 1000);
    const active24h = [...seenUsers.values()].filter((u) => now - u.ts < 86400).length;
    await sendMessage(
      chatId,
      `📊 آمار ربات سروش پلاس:\n👥 کل کاربران: ${seenUsers.size}\n🔥 فعال ۲۴ ساعت گذشته: ${active24h}`
    );
    return;
  }

  // لغو حالت ساخت عکس
  if (text === 'انصراف' || text === '/cancel') {
    const wasAwaiting = awaitingImage.delete(chatId);
    await sendMessage(chatId, wasAwaiting ? 'باشه، لغو شد 👌' : 'چیزی برای لغو نبود 😊');
    return;
  }

  // ساخت تصویر: فرمان مستقیم یا عبارت فارسی
  const directPrompt = extractImagePrompt(text);
  if (directPrompt !== null) {
    if (!directPrompt) {
      await sendMessage(chatId, IMAGE_HELP);
    } else {
      await generateAndSendImage(chatId, directPrompt);
    }
    return;
  }

  // ساخت تصویر: انتظار پرامپت بعد از دکمه «ساخت عکس»
  if (awaitingImage.get(chatId)) {
    awaitingImage.delete(chatId);
    await generateAndSendImage(chatId, text);
    return;
  }

  // نشانگر «در حال نوشتن...»
  sp('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {});

  const hist = getHistory(chatId);
  hist.push({ role: 'user', content: text });

  try {
    const client = await getZai();
    const completion = await client.chat.completions.create({
      messages: hist as never,
      thinking: { type: 'disabled' },
    });
    const reply = cleanReply(completion?.choices?.[0]?.message?.content ?? '');
    if (!reply) throw new Error('پاسخ خالی از هوش مصنوعی');
    hist.push({ role: 'assistant', content: reply });
    await sendMessage(chatId, reply);
    log(
      `چت ${chatId} | س: ${text.slice(0, 60).replace(/\n/g, ' ')} | ج: ${reply
        .slice(0, 60)
        .replace(/\n/g, ' ')}`
    );
  } catch (e) {
    log(`خطای LLM: ${(e as Error).message}`);
    hist.pop();
    await sendMessage(chatId, '😖 آخ! یه لحظه مشکلی پیش اومد. لطفاً دوباره بفرست.').catch(
      () => {}
    );
  }
}

// ---------- پردازش دکمه‌های شیشه‌ای ----------
async function handleCallback(cb: SpCallback) {
  const chatId = String(cb.message?.chat?.id ?? '');
  if (!chatId) return;
  registerUser(chatId, cb.from?.username, cb.from?.first_name);
  isOwner(chatId, cb.from?.username);

  // همیشه callback را پاس بده تا چرخ‌دنگ دکمه بایستد
  const answer = (text?: string) =>
    sp('answerCallbackQuery', { callback_query_id: cb.id, text }).catch(() => {});

  switch (cb.data) {
    case 'start_chat':
      awaitingImage.delete(chatId);
      await answer('🚀 بزن بریم!');
      await sendMessage(
        chatId,
        'عالیه! 🚀\nهرچی دوست داری بنویس — گپ، سوال، ترجمه، ایده...\n🖼️ برای عکس ساختن دکمه «ساخت عکس» یا فرمان /image\nمن همین‌جام و جوابت رو می‌دم 😊'
      );
      break;
    case 'make_image':
      awaitingImage.set(chatId, true);
      await answer('🖼️ آماده‌ام!');
      await sendMessage(
        chatId,
        '🖼️ توضیح عکسی که می‌خوای رو بنویس...\n\nمثلاً:\n«یک گربه فضایی روی ماه، کارتونی»\n«آسمان غروب روی دریا، واقع‌گرایانه»\n\nبرای لغو بنویس: انصراف'
      );
      break;
    case 'clear_chat':
      histories.set(chatId, [{ role: 'assistant', content: SYSTEM_PROMPT }]);
      await answer('پاک شد! 🧹');
      await sendMessage(chatId, '🧹 حافظه مکالمه پاک شد!\nمی‌تونیم از نو شروع کنیم 😄');
      break;
    case 'about':
      await answer();
      await sendMessage(chatId, ABOUT_TEXT);
      break;
    default:
      await answer();
  }
}

// ---------- پردازش هر آپدیت ----------
// پنجره جبران: بعد از بیدار شدن سرور، پیام‌های تا ۶۰ دقیقه پیش هم پاسخ داده می‌شوند
// (پیام‌های رسیده موقع خواب سندباکس گم نمی‌شوند)
const CATCHUP_MS = 12 * 60 * 60 * 1000; // گیت‌هاب: گپ بین شیفت‌ها جبران می‌شود

function dispatchUpdate(u: SpUpdate) {
  const msg = u.message;
  const cb = u.callback_query;

  if (msg?.chat?.id !== undefined && msg.chat.id !== null) {
    const date = msg.date ?? 0;
    if (date && date * 1000 < Date.now() - CATCHUP_MS) {
      log(`پیام قدیمی (${Math.round((Date.now() - date * 1000) / 60000)} دقیقه پیش) نادیده گرفته شد`);
      return;
    }
    enqueueChat(String(msg.chat.id), () => handleMessage(msg));
  } else if (cb?.message?.chat?.id !== undefined && cb.message.chat.id !== null) {
    const date = cb.message.date ?? 0;
    if (date && date * 1000 < Date.now() - CATCHUP_MS) {
      log(`دکمه قدیمی (${Math.round((Date.now() - date * 1000) / 60000)} دقیقه پیش) نادیده گرفته شد`);
      return;
    }
    enqueueChat(String(cb.message.chat.id), () => handleCallback(cb));
  }
}

// ورودی وب‌هوک — پلتفرم پیام کاربر را مستقیم به سرور می‌فرستد و سرور را بیدار می‌کند
export function handleWebhookUpdate(update: SpUpdate) {
  dispatchUpdate(update);
}

// ---------- حلقه polling ----------
let offset = 0;
let useAllowedUpdates = true;

async function pollLoop() {
  while (true) {
    const t0 = Date.now();
    try {
      const url = `${API}/getUpdates?timeout=25&offset=${offset}${
        useAllowedUpdates
          ? `&allowed_updates=${encodeURIComponent('["message","callback_query"]')}`
          : ''
      }`;
      const res = await fetch(url, { signal: AbortSignal.timeout(40_000) });
      const data = (await res.json()) as {
        ok: boolean;
        result?: SpUpdate[];
        description?: string;
      };
      if (data.ok && Array.isArray(data.result)) {
        for (const u of data.result) {
          offset = Math.max(offset, u.update_id + 1);
          dispatchUpdate(u); // موازی به ازای هر چت
        }
        // اگر long polling پشتیبانی نشد و بلافاصله خالی برگشت، استراحت کوتاه
        if (!data.result.length && Date.now() - t0 < 3000) await sleep(2500);
      } else {
        const desc = data.description ?? '?';
        if (useAllowedUpdates) {
          useAllowedUpdates = false; // دفعه بعد بدون allowed_updates
          log(`getUpdates با allowed_updates رد شد — ادامه بدون آن: ${desc}`);
        } else if (desc.includes('Conflict')) {
          // تداخل با یک polling دیگر (نشست قدیمی گیت‌وی) — استراحت طولانی تا خودش تمام شود
          log('تداخل getUpdates — استراحت ۴۵ ثانیه‌ای تا خاتمه نشست موازی…');
          await sleep(45_000);
          continue;
        } else {
          log(`خطای getUpdates: ${desc}`);
        }
        await sleep(5000);
      }
    } catch (e) {
      log(`خطای حلقه polling: ${(e as Error).message}`);
      await sleep(3000);
    }
  }
}

// ---------- راه‌اندازی ----------
export async function startSoroushBot() {
  loadSeenUsers();

  // ۱) اگر آدرس عمومی تنظیم شده باشد وب‌هوک فعال می‌شود (سروش پلاس setWebhook دارد)
  const base = getPublicBaseUrl();
  if (base) {
    const res = await sp(
      'setWebhook',
      { url: `${base}/api/hooks/soroush/${TOKEN}` },
      1
    );
    if (res) {
      log(`✅ وب‌هوک فعال شد → ${base}/api/hooks/soroush — polling خاموش است`);
      return;
    }
    log('setWebhook ناموفق بود — ادامه با polling');
  }

  // ۲) حالت polling (وقتی آدرس عمومی تنظیم نشده)
  log('✅ چت‌بات سروش پلاس روشن شد — long polling شروع شد (@FreeAIbot)');
  pollLoop().catch((e) => log(`خطای حلقه polling: ${(e as Error).message}`));
}
