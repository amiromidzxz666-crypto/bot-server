// ============================================================
// ماژول چت‌بات هوشمند روبیکا (سمت سرور Next.js)
// با instrumentation.ts موقع بالا آمدن سرور اجرا می‌شود
// API: https://botapi.rubika.ir/v3
// نکته‌های کشف‌شده با تست واقعی:
//   - منوی شیشه‌ای فقط با chat_keypad_type: "New" کار می‌کند
//   - getUpdates با پارامتر offset_id آپدیت‌ها را مصرف می‌کند
//   - برای پاسخ باید chat_id خودِ آپدیت استفاده شود (نه sender_id)
//   - API روبیکا متد ارسال عکس ندارد → تصویر با لینک عمومی ارسال می‌شود
// ============================================================
import { readFileSync, writeFileSync } from 'node:fs';
import ZAI from './zai-shim';

const TOKEN = process.env.RUBIKA_BOT_TOKEN ?? '';
const API = `https://botapi.rubika.ir/v3/${TOKEN}`;
const OWNER_CHAT_ID = process.env.RUBIKA_OWNER_CHAT_ID ?? ''; // از Secrets
const OWNER_USER_ID = process.env.RUBIKA_OWNER_USER_ID ?? ''; // از Secrets
const CHUNK_LIMIT = 3500;
// پنجره جبران: بعد از بیدار شدن سرور، پیام‌های تا ۶۰ دقیقه پیش هم پاسخ داده می‌شوند
const CATCHUP_MS = 12 * 60 * 60 * 1000; // گیت‌هاب: گپ بین شیفت‌ها جبران می‌شود
const MAX_HISTORY = 20;
const HTTP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

// ---------- متن‌های ربات ----------
const SYSTEM_PROMPT = `تو یک دستیار چت هوشمند و صمیمی هستی که داخل یک ربات روبیکا به کاربر فارسی‌زبان پاسخ می‌دهی.

ویژگی‌هایت:
- گرم، خودمانی و دوستانه حرف می‌زنی و از ایموجی‌های مناسب و به‌جا استفاده می‌کنی.
- به هر سوالی جواب می‌دهی: عمومی، علمی، فنی، سرگرمی، ترجمه، نویسندگی خلاقانه و...
- جواب‌هایت را برای روبیکا مناسب می‌سازی: کوتاه تا متوسط، بدون فرمت markdown پیچیده — فقط متن ساده با خطوط جدید.
- اگر سوال مبهم بود، یک جمله سوال شفاف‌سازی می‌پرسی.
- اگر جواب بلند شد، آن را مرتب و خوانا با خطوط جدا کن.
- همیشه به همان زبانی جواب می‌دهی که کاربر با آن نوشته (پیش‌فرض: فارسی).
- اطلاعات شخصی کاربر را محترمانه نگه می‌داری.`;

const WELCOME = `سلام! 👋 به چت‌بات هوشمند و رایگان خوش اومدی 🤖✨

💬 باهات گپ می‌زنم و به هر سوالی جواب می‌دم — بدون اینکه از روبیکا خارج بشی 😊
🖼️ عکس هم با هوش مصنوعی برات می‌سازم!

از دکمه‌های زیر استفاده کن یا همین‌جا مستقیم بنویس! 👇`;

const ABOUT_TEXT = `ℹ️ درباره ما

این ابزار کاملا رایگان توسعه داده شده برای شما تا رایگان هر چقدر خواستید چت کنید و سوالات تون رو بپرسید بدون اینکه از روبیکا خارج بشید♥️`;

const IMAGE_HELP = `🖼️ برای ساخت عکس، توضیحش رو برام بنویس:

/image یک گربه فضایی روی ماه
/عکس خانه‌ای آینده‌نگر زیر باران نئونی

💡 نکته: اگه توی توضیحت «عمودی» یا «افقی» بنویسی، عکس همون‌طور ساخته می‌شه!`;

// ---------- منوی شیشه‌ای (تست‌شده و تأییدشده با chat_keypad_type: "New") ----------
const START_KEYPAD = {
  rows: [
    { buttons: [{ id: 'start_chat', type: 'Simple', button_text: '🚀 شروع چت' }] },
    {
      buttons: [
        { id: 'make_image', type: 'Simple', button_text: '🖼 ساخت عکس' },
        { id: 'clear_chat', type: 'Simple', button_text: '🧹 پاکسازی چت' },
      ],
    },
    { buttons: [{ id: 'about', type: 'Simple', button_text: 'ℹ️ درباره ما' }] },
  ],
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const log = (m: string) => console.log(`[RB-BOT] ${new Date().toISOString()} ${m}`);

let zai: Awaited<ReturnType<typeof ZAI.create>> | null = null;
async function getZai() {
  if (!zai) zai = await ZAI.create();
  return zai;
}

// ---------- انواع API روبیکا ----------
type RbMessage = {
  message_id?: string;
  text?: string;
  caption?: string;
  time?: string | number;
  is_edited?: boolean;
  sender_type?: string;
  sender_id?: string;
  aux_data?: { button_id?: string; start_id?: string } & Record<string, unknown>;
};

type RbUpdate = {
  type?: string;
  chat_id?: string;
  update_time?: string | number;
  new_message?: RbMessage;
  aux_data?: { button_id?: string; start_id?: string } & Record<string, unknown>;
};

type RbResponse = {
  status?: string;
  dev_message?: string;
  data?: {
    updates?: RbUpdate[];
    next_offset_id?: string;
    message_id?: string;
    bot?: { bot_id?: string; bot_title?: string; username?: string };
  };
};

// ---------- فراخوانی API روبیکا ----------
async function rb(
  method: string,
  params: Record<string, unknown>,
  retries = 1,
  timeoutMs = 35_000
): Promise<RbResponse | null> {
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(`${API}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const raw = await res.text();
      try {
        return JSON.parse(raw) as RbResponse;
      } catch {
        log(`پاسخ غیر JSON از ${method} (HTTP ${res.status}): ${raw.slice(0, 150)}`);
        return null;
      }
    } catch (e) {
      log(`خطای شبکه روبیکا (${method}): ${(e as Error).message}`);
      if (i < retries) await sleep(1500);
    }
  }
  return null;
}

async function sendMessage(chatId: string, text: string, keypad?: object): Promise<boolean> {
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
    const params: Record<string, unknown> = { chat_id: chatId, text: chunks[i] || '...' };
    if (keypad && i === 0) {
      params.chat_keypad_type = 'New';
      params.chat_keypad = keypad;
    }
    const r = await rb('sendMessage', params);
    if (!r || r.status !== 'OK') {
      ok = false;
      log(
        `خطای sendMessage به ${chatId}: ${r?.dev_message ?? JSON.stringify(r ?? {}).slice(0, 150)}`
      );
    }
  }
  return ok;
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

// ---------- ثبت‌نام کاربران (برای پیام همگانی و آمار) ----------
const USERS_FILE = `${process.env.DATA_DIR ?? '/app/db'}/rubika-users.json`;

type SeenUser = { user_id?: string; ts: number };
const seenUsers = new Map<string, SeenUser>();

function loadSeenUsers() {
  try {
    const obj = JSON.parse(readFileSync(USERS_FILE, 'utf8')) as Record<string, SeenUser>;
    for (const [k, v] of Object.entries(obj)) seenUsers.set(k, v);
    log(`👥 ${seenUsers.size} کاربر شناخته‌شده روبیکا لود شد`);
  } catch {
    log('فایل کاربران روبیکا یافت نشد — از نو ساخته می‌شود');
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

function registerUser(chatId: string, userId?: string) {
  const prev = seenUsers.get(chatId);
  const now = Math.floor(Date.now() / 1000);
  if (!prev || now - prev.ts > 3600) {
    seenUsers.set(chatId, { user_id: userId, ts: now });
    scheduleSaveSeenUsers();
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

// آپلود تصویر روی هاست عمومی — API روبیکا ارسال مستقیم فایل ندارد
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

  // روبیکا نشانگر «در حال نوشتن» ندارد → پیام لحظه‌ای می‌فرستیم
  await sendMessage(chatId, '⏳ در حال ساخت عکست... چند لحظه صبر کن 🎨');

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
    log(`تصویر تولید شد (${size}، ${(buffer.length / 1024).toFixed(0)}KB) — در حال آپلود...`);

    // ۴) آپلود روی هاست عمومی و ارسال لینک
    const url = await hostImage(buffer);
    if (!url) throw new Error('آپلود تصویر روی هاست ناموفق بود');

    await sendMessage(
      chatId,
      `🖼️ عکس ساخته شد! ✨\n\n📝 توضیح شما: ${rawPrompt.slice(0, 200)}\n\n🔗 دیدن و دانلود عکس (روی لینک بزن):\n${url}\n\n💡 برای عکس بعدی بنویس: عکس ... بساز`
    );
    log(`تصویر ${chatId} ارسال شد (${size}) → ${url}`);
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
  }
}

// ---------- خوش‌آمدگویی (با خنک‌کننده ضد تکرار) ----------
const lastWelcome = new Map<string, number>();
async function welcome(chatId: string) {
  const now = Date.now();
  if (now - (lastWelcome.get(chatId) || 0) < 5000) return;
  lastWelcome.set(chatId, now);
  histories.set(chatId, [{ role: 'assistant', content: SYSTEM_PROMPT }]);
  awaitingImage.delete(chatId);
  await sendMessage(chatId, WELCOME, START_KEYPAD);
}

// پاکسازی پاسخ مدل: بلوک <think> و تگ‌های جا‌افتاده حذف شود
function cleanReply(t: string): string {
  return t
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<\/?think>/gi, '')
    .trim();
}

async function handleMessage(chatId: string, senderId: string, text: string) {
  if (tooFast(chatId)) return; // اسپم را بی‌صدا رد کن

  if (text === '/start' || text === '/help') {
    await welcome(chatId);
    return;
  }
  if (text === '/new' || text === '/clear') {
    histories.set(chatId, [{ role: 'assistant', content: SYSTEM_PROMPT }]);
    awaitingImage.delete(chatId);
    await sendMessage(chatId, '🧹 حافظه مکالمه پاک شد! از نو شروع کنیم 😄');
    return;
  }

  // ---------- فرمان‌های مدیر (فقط مالک ربات) ----------
  if (senderId === OWNER_USER_ID && text.startsWith('/broadcast')) {
    const bcText = text.replace(/^\/broadcast\s*/, '').trim();
    if (!bcText) {
      await sendMessage(
        chatId,
        '📢 استفاده:\n/broadcast متن پیام\n\nمتن برای همه کاربران روبیکای ربات ارسال می‌شود.'
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
  if (senderId === OWNER_USER_ID && text.startsWith('/stats')) {
    const now = Math.floor(Date.now() / 1000);
    const active24h = [...seenUsers.values()].filter((u) => now - u.ts < 86400).length;
    await sendMessage(
      chatId,
      `📊 آمار ربات روبیکا:\n👥 کل کاربران: ${seenUsers.size}\n🔥 فعال ۲۴ ساعت گذشته: ${active24h}`
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
async function handleCallback(chatId: string, buttonId: string) {
  log(`دکمه ${buttonId} از ${chatId}`);
  switch (buttonId) {
    case 'start_chat':
      awaitingImage.delete(chatId);
      await sendMessage(
        chatId,
        'عالیه! 🚀\nهرچی دوست داری بنویس — گپ، سوال، ترجمه، ایده...\n🖼️ برای عکس ساختن دکمه «ساخت عکس» یا فرمان /image\nمن همین‌جام و جوابت رو می‌دم 😊'
      );
      break;
    case 'make_image':
      awaitingImage.set(chatId, true);
      await sendMessage(
        chatId,
        '🖼️ توضیح عکسی که می‌خوای رو بنویس...\n\nمثلاً:\n«یک گربه فضایی روی ماه، کارتونی»\n«آسمان غروب روی دریا، واقع‌گرایانه»\n\nبرای لغو بنویس: انصراف'
      );
      break;
    case 'clear_chat':
      histories.set(chatId, [{ role: 'assistant', content: SYSTEM_PROMPT }]);
      await sendMessage(chatId, '🧹 حافظه مکالمه پاک شد!\nمی‌تونیم از نو شروع کنیم 😄');
      break;
    case 'about':
      await sendMessage(chatId, ABOUT_TEXT);
      break;
    default:
      log(`دکمه ناشناخته: ${buttonId}`);
  }
}

// ---------- پردازش هر آپدیت ----------
async function handleUpdate(u: RbUpdate) {
  const chatId = String(u?.chat_id || '');
  if (!chatId) return;

  // پنجره جبران — پیام‌های خیلی قدیمی رد می‌شوند، تا ۱۰ دقیقه پیش پاسخ می‌گیرند
  const t = Number(u?.update_time || 0) * 1000;
  if (t && t < Date.now() - CATCHUP_MS) return;

  const msg = u?.new_message;
  const senderId = String(msg?.sender_id || '');

  // شروع ربات توسط کاربر (بدون پیام متنی)
  if (u?.type === 'StartedBot' && !msg) {
    registerUser(chatId);
    await welcome(chatId);
    return;
  }
  if (!msg) return;
  if (msg.sender_type === 'Bot') return;
  registerUser(chatId, senderId);

  // دکمه شیشه‌ای فشرده شده (aux_data داخل پیام یا سطح آپدیت)
  const aux = msg?.aux_data || u?.aux_data || null;
  const buttonId = String(aux?.button_id || '');
  if (buttonId) {
    await handleCallback(chatId, buttonId);
    return;
  }
  if (aux && !buttonId && Object.keys(aux).some((k) => k.includes('button'))) {
    log(`aux_data ناشناخته: ${JSON.stringify(aux).slice(0, 200)}`);
  }

  const text = String(msg?.text || msg?.caption || '').trim();
  if (!text) {
    if (awaitingImage.get(chatId)) {
      await sendMessage(chatId, '🖼️ برای ساخت عکس، توضیحش رو متنی برام بنویس...');
    } else {
      await sendMessage(chatId, 'الان فقط متن رو می‌فهمم 🙏 اگه چیزی دوست داری، برام بنویس! 😊');
    }
    return;
  }

  await handleMessage(chatId, senderId, text);
}

// ---------- حلقه polling ----------
let nextOffset = '';

async function pollLoop() {
  while (true) {
    const t0 = Date.now();
    try {
      const data = await rb(
        'getUpdates',
        { limit: 20, timeout: 25, offset_id: nextOffset },
        0,
        40_000
      );
      const elapsed = Date.now() - t0;
      if (data?.status === 'OK' && data.data) {
        nextOffset = data.data.next_offset_id || nextOffset;
        const updates = data.data.updates || [];
        for (const u of updates) {
          try {
            await handleUpdate(u);
          } catch (e) {
            log(`خطای پردازش آپدیت: ${(e as Error).message}`);
          }
        }
        // اگر long polling پشتیبانی نشد و بلافاصله خالی برگشت، استراحت کوتاه
        if (!updates.length && elapsed < 3000) await sleep(2500);
      } else {
        log(
          `خطای getUpdates: ${data?.dev_message ?? JSON.stringify(data ?? {}).slice(0, 150)}`
        );
        await sleep(5000);
      }
    } catch (e) {
      log(`خطای حلقه polling: ${(e as Error).message}`);
      await sleep(5000);
    }
  }
}

// ---------- راه‌اندازی ----------
export function startRubikaBot() {
  loadSeenUsers();
  log('✅ چت‌بات روبیکا روشن شد — long polling شروع شد');
  pollLoop().catch((e) => log(`خطای حلقه polling: ${(e as Error).message}`));

  // اطلاع‌رسانی به مالک که ربات آنلاین است
  setTimeout(() => {
    sendMessage(
      OWNER_CHAT_ID,
      '🤖✨ چت‌بات روبیکا روشن شد!\n\nحالا داخل روبیکا هم هر سوالی داری بپرس و عکس بساز 😊\nبرای شروع /start رو بزن!'
    ).catch(() => {});
  }, 2000);
}
