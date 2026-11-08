// ============================================================
// ربات تلگرام Wifto (@WiftoBot) — اینترنت رایگان
// بخش‌ها: ماموریت‌ها، قرعه‌کشی، خرید امتیاز، حساب کاربری، پشتیبانی
// بدون هیچ هوش مصنوعی — همه منطق قاعده‌محور است
// با instrumentation.ts موقع بالا آمدن سرور اجرا می‌شود
// ============================================================
import { readFileSync, writeFileSync } from 'node:fs';
import { getPublicBaseUrl } from './public-url';
import { ensureUser, getUserByTg, faTime, fmtNum, toEnDigits } from './wifto-db';

export const TOKEN = process.env.TG_MAIN_BOT_TOKEN ?? '';
const ADMIN_TOKEN = process.env.TG_ADMIN_BOT_TOKEN ?? ''; // برای ارسال ارسالی‌ها به پنل مدیر
const API = `https://api.telegram.org/bot${TOKEN}`;
const ADMIN_API = `https://api.telegram.org/bot${ADMIN_TOKEN}`;
const OWNER_CHAT_ID = process.env.OWNER_TG_CHAT_ID ? Number(process.env.OWNER_TG_CHAT_ID) : 0; // از Secrets
const TG_LIMIT = 4000;

// ---------- تنظیمات فروش امتیاز ----------
const CARD_NO = '6219861852598258';
const CARD_NAME = 'امیرحسین محمدزاده';
const SUPPORT_CHANNEL = '@Notification_Wifto';
const PRICE_PER_POINT = 1000; // تومان به ازای هر امتیاز
const BONUS_MIN_TOMAN = 30000; // بالای این مبلغ ضریب می‌گیرد
const BONUS_FACTOR = 2;

// ---------- متن‌های ربات ----------

const WELCOME = (name?: string) => `سلام ${name ? `${name} عزیز` : ''}! 👋

به ربات Wifto خوش اومدی 🌐

🎯 ماموریت انجام بده و امتیاز بگیر
🎰 تو قرعه‌کشی‌ها شانس برنده شدن داشته باش
💎 امتیاز بخر یا اینترنت رایگان هدیه بگیر

از منوی زیر انتخاب کن 👇`;

const MENU_HINT = `لطفاً از دکمه‌های منوی زیر استفاده کن 👇`;

const SUPPORT_TEXT = `🎧 پشتیبانی

جهت ارتباط با پشتیبانی به دایرکت این کانال مراجعه کنید:
${SUPPORT_CHANNEL}`;

const NO_MISSIONS = `🎯 ماموریت‌ها

فعلاً ماموریت فعالی وجود ندارد ⏳
به‌زودی ماموریت‌های جدید همین‌جا قرار می‌گیرد — منتظر باش!`;

const NO_LOTTERY = `🎰 قرعه‌کشی

در حال حاضر قرعه‌کشی فعالی وجود ندارد ⏳

امتیازهایت را با انجام ماموریت‌ها جمع کن تا تو قرعه‌کشی‌های بعدی شانس بیشتری داشته باشی 🍀`;

const MAIN_KEYBOARD = {
  keyboard: [
    [{ text: '🎯 ماموریت‌ها' }],
    [{ text: '🎰 قرعه‌کشی' }],
    [{ text: '💎 خرید امتیاز' }],
    [{ text: '👤 حساب کاربری' }, { text: '🎧 پشتیبانی' }],
  ],
  resize_keyboard: true,
  is_persistent: true,
};

// کیبورد ارسال شماره تلفن (دکمه request_contact — کاربر فقط لمس می‌کند و تلگرام شماره را می‌فرستد)
const PHONE_KB = {
  keyboard: [
    [{ text: '📱 ارسال شماره تلفن', request_contact: true }],
    [{ text: 'انصراف' }],
  ],
  resize_keyboard: true,
  one_time_keyboard: false,
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
        result?: { message_id?: number };
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

/** ارسال به چت مدیر از طریق ربات پنل (@HmganBot) */
async function tgAdmin(method: string, params: Record<string, unknown>, retries = 2) {
  if (!ADMIN_TOKEN) return null;
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(`${ADMIN_API}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      });
      const data = (await res.json()) as {
        ok: boolean;
        result?: { message_id?: number };
        parameters?: { retry_after?: number };
        description?: string;
      };
      if (data.ok) return data;
      if (data.parameters?.retry_after && i < retries) {
        await sleep((data.parameters.retry_after + 1) * 1000);
        continue;
      }
      log(`خطای تلگرام مدیر (${method}): ${data.description ?? '?'}`);
      return null;
    } catch (e) {
      log(`خطای شبکه تلگرام مدیر (${method}): ${(e as Error).message}`);
      if (i < retries) await sleep(1500 * (i + 1));
    }
  }
  return null;
}

/** دانلود بایت‌های فایل با توکن ربات اصلی (file_id بین ربات‌ها قابل انتقال نیست) */
async function downloadFileBytes(filePath: string): Promise<ArrayBuffer | null> {
  try {
    const res = await fetch(`https://api.telegram.org/file/bot${TOKEN}/${filePath}`, {
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      log(`دانلود فایل ناموفق: HTTP ${res.status}`);
      return null;
    }
    return await res.arrayBuffer();
  } catch (e) {
    log(`خطای دانلود فایل: ${(e as Error).message}`);
    return null;
  }
}

/**
 * ارسال عکس به چت مدیر از طریق ربات پنل (@HmganBot)
 * نکته مهم: file_id دریافتی از کاربر متعلق به ربات اصلی است و ربات پنل با آن
 * نمی‌تواند sendPhoto بزند (file_id بین ربات‌ها قابل انتقال نیست)؛ پس بایت‌های عکس
 * با توکن اصلی دانلود و به‌صورت multipart به API پنل آپلود می‌شود.
 */
async function sendPhotoToPanel(
  fileId: string,
  caption: string,
  replyMarkup?: object
): Promise<{ ok: boolean; messageId?: number; error?: string }> {
  if (!ADMIN_TOKEN) return { ok: false, error: 'TG_ADMIN_BOT_TOKEN تنظیم نشده است' };
  const g = (await tg('getFile', { file_id: fileId })) as unknown as
    | { result?: { file_path?: string } }
    | null;
  const filePath = g?.result?.file_path;
  if (!filePath) return { ok: false, error: 'getFile ناموفق بود' };
  const bytes = await downloadFileBytes(filePath);
  if (!bytes) return { ok: false, error: 'دانلود بایت‌های عکس ناموفق بود' };
  for (let i = 0; i <= 3; i++) {
    try {
      const form = new FormData();
      form.append('chat_id', String(OWNER_CHAT_ID));
      form.append('caption', caption.slice(0, 1024));
      if (replyMarkup) form.append('reply_markup', JSON.stringify(replyMarkup));
      form.append('photo', new Blob([bytes], { type: 'image/jpeg' }), 'photo.jpg');
      const res = await fetch(`${ADMIN_API}/sendPhoto`, { method: 'POST', body: form });
      const data = (await res.json()) as {
        ok: boolean;
        result?: { message_id?: number };
        description?: string;
      };
      if (data.ok) return { ok: true, messageId: data.result?.message_id };
      log(`خطای ارسال عکس به پنل (sendPhoto): ${data.description ?? '?'}`);
      return { ok: false, error: data.description ?? 'sendPhoto ناموفق بود' };
    } catch (e) {
      log(`خطای شبکه ارسال عکس به پنل (تلاش ${i + 1}): ${(e as Error).message}`);
      if (i < 3) await sleep(1500 * (i + 1));
      else return { ok: false, error: (e as Error).message };
    }
  }
  return { ok: false, error: 'نامشخص' };
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
  photo?: { file_id: string; width: number; height: number }[];
  contact?: { phone_number?: string };
};

// ---------- حالت‌های گفتگوی کاربر ----------
type UserState =
  | { kind: 'mission_photo'; missionId: string; missionTitle: string; fileId?: string }
  | { kind: 'buy_amount' }
  | { kind: 'buy_receipt'; points: number; toman: number; fileId?: string }
  | { kind: 'phone'; phone?: string };

const userStates = new Map<number, UserState>();

// دکمه‌های تایید/انصراف ارسال عکس
const PHOTO_CONFIRM_KB = (okData: string) => ({
  inline_keyboard: [
    [
      { text: '✅ تایید و ارسال', callback_data: okData },
      { text: '❌ انصراف', callback_data: 'xst' },
    ],
  ],
});

function rewardText(m: { rewardType: string; rewardPoints?: number | null }): string {
  return m.rewardType === 'internet'
    ? '🌐 اینترنت رایگان'
    : `💎 ${fmtNum(m.rewardPoints ?? 0)} امتیاز`;
}

// ---------- ماموریت‌ها ----------
async function sendMissionsList(chatId: number) {
  const { p } = await import('./wifto-db');
  const missions = await p.mission.findMany({
    where: { active: true },
    orderBy: { createdAt: 'desc' },
  });
  if (!missions.length) {
    await sendMessage(chatId, NO_MISSIONS, MAIN_KEYBOARD);
    return;
  }
  const rows = missions.map((m) => [
    { text: `🎯 ${m.title}`, callback_data: `m:${m.id}` },
  ]);
  rows.push([{ text: '🔄 بروزرسانی لیست', callback_data: 'mlist' }]);
  await sendMessage(chatId, `🎯 ماموریت‌ها\n\nروی هر ماموریت بزن تا توضیحات و نحوه انجامش رو ببینی 👇`, {
    inline_keyboard: rows,
  });
}

async function sendMissionDetail(chatId: number, missionId: string) {
  const { p } = await import('./wifto-db');
  const m = await p.mission.findUnique({ where: { id: missionId } });
  if (!m || !m.active) {
    await sendMessage(chatId, 'این ماموریت دیگر فعال نیست 🙏', MAIN_KEYBOARD);
    return;
  }
  await sendMessage(
    chatId,
    `🎯 ${m.title}\n\n📝 توضیحات:\n${m.description}\n\n📋 نحوه انجام و اسکرین‌شات:\n${m.howTo}\n\n🎁 پاداش: ${rewardText(m)}`,
    {
      inline_keyboard: [
        [{ text: '📸 ارسال اسکرین‌شات', callback_data: `ms:${m.id}` }],
        [{ text: '📚 لیست ماموریت‌ها', callback_data: 'mlist' }],
      ],
    }
  );
}

async function startMissionPhoto(chatId: number, missionId: string) {
  const { p } = await import('./wifto-db');
  const m = await p.mission.findUnique({ where: { id: missionId } });
  if (!m || !m.active) {
    await sendMessage(chatId, 'این ماموریت دیگر فعال نیست 🙏', MAIN_KEYBOARD);
    return;
  }
  // جلوگیری از ارسال تکراری وقتی یک ارسال در انتظار بررسی است
  const pending = await p.submission.findFirst({
    where: { userTgId: String(chatId), missionId, type: 'mission', status: 'pending' },
  });
  if (pending) {
    await sendMessage(
      chatId,
      '⏳ این ماموریت قبلاً ارسال کرده‌ای و در انتظار بررسی است.\nنتیجه بررسی بهت اطلاع داده می‌شود 🙏',
      MAIN_KEYBOARD
    );
    return;
  }
  userStates.set(chatId, { kind: 'mission_photo', missionId, missionTitle: m.title });
  await sendMessage(
    chatId,
    `📸 صفحه ارسال اسکرین‌شات\n\n🎯 ماموریت: ${m.title}\n\n📋 ${m.howTo}\n\nحالا عکس (اسکرین‌شات) خود را بفرست:`,
    { inline_keyboard: [[{ text: '❌ انصراف', callback_data: 'xst' }]] }
  );
}

async function submitMissionPhoto(chatId: number, firstName?: string, username?: string) {
  const st = userStates.get(chatId);
  if (st?.kind !== 'mission_photo' || !st.fileId) {
    userStates.delete(chatId);
    await sendMessage(chatId, '⏳ مهلت این درخواست گذشت — لطفاً دوباره از منوی ماموریت‌ها تلاش کن 🙏', MAIN_KEYBOARD);
    return;
  }
  const { p, userLabel } = await import('./wifto-db');
  const m = await p.mission.findUnique({ where: { id: st.missionId } });
  if (!m) {
    await sendMessage(chatId, 'ماموریت پیدا نشد 🙏', MAIN_KEYBOARD);
    userStates.delete(chatId);
    return;
  }
  const tgId = String(chatId);
  // برچسب کامل کاربر: نام + یوزرنیم + آیدی عددی — اگر پیام زنده یوزرنیم نداشت از دیتابیس پر می‌شود
  const dbu = await getUserByTg(tgId).catch(() => null);
  const label = userLabel({
    firstName: firstName ?? dbu?.firstName,
    username: username ?? dbu?.username,
    tgId,
  });
  const sub = await p.submission.create({
    data: {
      type: 'mission',
      userTgId: tgId,
      userLabel: label,
      missionId: m.id,
      missionTitle: m.title,
      photoFileId: st.fileId,
    },
  });
  // ارسال عکس به پنل مدیر (آپلود بایت‌ها — file_id بین ربات‌ها قابل انتقال نیست)
  const sent = await sendPhotoToPanel(
    st.fileId,
    `📥 ارسالی جدید — 🎯 ماموریت\n\n` +
      `👤 کاربر: ${label}\n` +
      `🎯 ماموریت: ${m.title}\n` +
      `🎁 پاداش پیشنهادی: ${rewardText(m)}\n` +
      `⏰ ${faTime(new Date())}`,
    {
      inline_keyboard: [
        [
          { text: '✅ تایید', callback_data: `s_ok:${sub.id}` },
          { text: '❌ لغو', callback_data: `s_no:${sub.id}` },
        ],
        [{ text: '🗑 پاک کردن', callback_data: `s_del:${sub.id}` }],
      ],
    }
  );
  if (sent.ok && sent.messageId) {
    await p.submission.update({ where: { id: sub.id }, data: { adminMsgId: sent.messageId } });
  } else {
    // ارسال به پنل شکست خورد — رکورد بی‌عکس در لیست پنل نماند؛ کاربر دوباره تلاش می‌کند
    await p.submission
      .update({ where: { id: sub.id }, data: { status: 'error', resolvedAt: new Date() } })
      .catch(() => {});
    log(`ارسال عکس ماموریت به پنل ناموفق: ${sent.error} — کاربر باید دوباره تلاش کند`);
    await sendMessage(
      chatId,
      '⚠️ ارسال به پشتیبانی موقتاً ناموفق بود!\n\nچند لحظه بعد دوباره از منوی ماموریت‌ها تلاش کن 🙏',
      MAIN_KEYBOARD
    );
    return;
  }
  userStates.delete(chatId);
  await sendMessage(
    chatId,
    '✅ ارسال شد!\n\nعکست به پشتیبانی رسید و در صف بررسی است؛ نتیجه‌اش رو همین‌جا بهت اطلاع می‌دیم 🙏',
    MAIN_KEYBOARD
  );
}

// ---------- قرعه‌کشی ----------
async function sendLotteryPage(chatId: number) {
  const { p } = await import('./wifto-db');
  const lot = await p.lottery.findFirst({ where: { status: 'open' }, orderBy: { createdAt: 'desc' } });
  if (!lot) {
    await sendMessage(chatId, NO_LOTTERY, MAIN_KEYBOARD);
    return;
  }
  const entries = await p.lotteryEntry.findMany({ where: { lotteryId: lot.id } });
  const u = await getUserByTg(String(chatId));
  const total = entries.reduce((s, e) => s + e.points, 0);
  const joined = entries.some((e) => e.userTgId === String(chatId));
  let text =
    `🎰 قرعه‌کشی فعال!\n\n${lot.title}\n\n` +
    `🎟 شرکت‌کنندگان: ${fmtNum(entries.length)} نفر\n` +
    `💎 مجموع امتیازهای قرعه‌کشی: ${fmtNum(total)}\n\n` +
    `هر کی امتیاز بیشتری داشته باشه، شانس برنده شدنش بیشتره! 🍀\n\n` +
    `💎 امتیاز فعلی شما: ${fmtNum(u?.points ?? 0)}\n`;
  if (joined) {
    text += '\n✅ شما در این قرعه‌کشی ثبت‌نام کرده‌اید!\nبا انجام ماموریت‌های فعال می‌تونی برای قرعه‌کشی‌های بعدی دوباره امتیاز جمع کنی 🎯';
    await sendMessage(chatId, text, MAIN_KEYBOARD);
    return;
  }
  await sendMessage(chatId, text, {
    inline_keyboard: [[{ text: '🎟 شرکت در قرعه‌کشی', callback_data: 'lot_join' }]],
  });
}

/** نمایش صفحه تایید نهایی شرکت در قرعه‌کشی */
async function askLotteryJoin(chatId: number) {
  const { p } = await import('./wifto-db');
  const tgId = String(chatId);
  const lot = await p.lottery.findFirst({ where: { status: 'open' }, orderBy: { createdAt: 'desc' } });
  if (!lot) {
    await sendMessage(chatId, NO_LOTTERY, MAIN_KEYBOARD);
    return;
  }
  const u = await getUserByTg(tgId);
  if (!u || u.points < 1) {
    await sendMessage(
      chatId,
      '💎 برای شرکت در قرعه‌کشی حداقل ۱ امتیاز لازم است!\n\nبا انجام ماموریت‌های فعال امتیاز جمع کن بعد بیا 🎯',
      MAIN_KEYBOARD
    );
    return;
  }
  const already = await p.lotteryEntry.findUnique({
    where: { lotteryId_userTgId: { lotteryId: lot.id, userTgId: tgId } },
  });
  if (already) {
    await sendMessage(chatId, '✅ شما قبلاً در این قرعه‌کشی شرکت کرده‌اید 🍀', MAIN_KEYBOARD);
    return;
  }
  await sendMessage(
    chatId,
    `🎟 شرکت در قرعه‌کشی\n\n💎 امتیاز فعلی شما: ${fmtNum(u.points)}\n\nبا تایید، همه امتیازت وارد قرعه‌کشی می‌شه و حسابت صفر می‌شه.\n\nمطمئنی؟`,
    {
      inline_keyboard: [
        [
          { text: '✅ تایید و ثبت', callback_data: 'lot_yes' },
          { text: '❌ انصراف', callback_data: 'xst' },
        ],
      ],
    }
  );
}

async function confirmLotteryJoin(chatId: number) {
  const { p } = await import('./wifto-db');
  const tgId = String(chatId);
  const lot = await p.lottery.findFirst({ where: { status: 'open' }, orderBy: { createdAt: 'desc' } });
  if (!lot) {
    await sendMessage(chatId, NO_LOTTERY, MAIN_KEYBOARD);
    return;
  }
  const u = await getUserByTg(tgId);
  if (!u || u.points < 1) {
    await sendMessage(chatId, '💎 امتیازی برای شرکت در قرعه‌کشی نداری — اول ماموریت انجام بده 🎯', MAIN_KEYBOARD);
    return;
  }
  const already = await p.lotteryEntry.findUnique({
    where: { lotteryId_userTgId: { lotteryId: lot.id, userTgId: tgId } },
  });
  if (already) {
    await sendMessage(chatId, '✅ شما قبلاً در این قرعه‌کشی شرکت کرده‌اید 🍀', MAIN_KEYBOARD);
    return;
  }
  // امتیازها قفل می‌شوند
  const pts = u.points;
  await p.$transaction([
    p.botUser.update({ where: { tgId }, data: { points: { decrement: pts }, lotteries: { increment: 1 } } }),
    p.lotteryEntry.create({ data: { lotteryId: lot.id, userTgId: tgId, points: pts } }),
  ]);
  await sendMessage(
    chatId,
    `✅ شرکتت در قرعه‌کشی ثبت شد! 🍀\n\n💎 ${fmtNum(pts)} امتیازت وارد قرعه‌کشی شد.\n\nمی‌تونی با انجام ماموریت‌های فعال دوباره امتیاز جمع کنی 🎯`,
    MAIN_KEYBOARD
  );
}

// ---------- خرید امتیاز ----------
async function startBuy(chatId: number) {
  userStates.set(chatId, { kind: 'buy_amount' });
  await sendMessage(
    chatId,
    `💎 خرید امتیاز

مقدار امتیازی که می‌خوای بخری رو مشخص کن (عدد بفرست):

💵 هر امتیاز = ${fmtNum(PRICE_PER_POINT)} تومان
🎁 اگر بالای ${fmtNum(BONUS_MIN_TOMAN)} تومان خرید کنی، امتیازت ${BONUS_FACTOR} برابر می‌شه!

مثلاً: 30`,
    { inline_keyboard: [[{ text: '❌ انصراف', callback_data: 'xst' }]] }
  );
}

async function handleBuyAmount(chatId: number, raw: string) {
  const n = parseInt(toEnDigits(raw).replace(/[^\d]/g, ''), 10);
  if (!n || n < 1 || n > 100000) {
    await sendMessage(chatId, '⛔ عدد معتبر بفرست (مثلاً 10 یا 50):');
    return;
  }
  const toman = n * PRICE_PER_POINT;
  const bonus = toman >= BONUS_MIN_TOMAN;
  const finalPoints = bonus ? n * BONUS_FACTOR : n;
  userStates.set(chatId, { kind: 'buy_receipt', points: n, toman });
  let text =
    `🧾 فاکتور خرید\n\n` +
    `💎 امتیاز درخواستی: ${fmtNum(n)}\n` +
    `💳 مبلغ پرداخت: ${fmtNum(toman)} تومان\n`;
  if (bonus) text += `🎁 هدیه ضریب: به‌جای ${fmtNum(n)} امتیاز، ${fmtNum(finalPoints)} امتیاز می‌گیری!\n`;
  text +=
    `\n💳 شماره کارت:\n${CARD_NO}\n👤 به نام: ${CARD_NAME}\n\n` +
    `بعد از کارت‌به‌کارت، روی دکمه «📸 ارسال رسید» بزن و عکس رسید رو بفرست:`;
  await sendMessage(chatId, text, {
    inline_keyboard: [
      [{ text: '📸 ارسال رسید', callback_data: 'buy_ask' }],
      [{ text: '❌ انصراف', callback_data: 'xst' }],
    ],
  });
}

async function submitPurchaseReceipt(chatId: number, firstName?: string, username?: string) {
  const st = userStates.get(chatId);
  if (st?.kind !== 'buy_receipt' || !st.fileId) {
    userStates.delete(chatId);
    await sendMessage(chatId, '⏳ مهلت این درخواست گذشت — لطفاً دوباره از منوی خرید امتیاز تلاش کن 🙏', MAIN_KEYBOARD);
    return;
  }
  const { p, userLabel } = await import('./wifto-db');
  const tgId = String(chatId);
  // برچسب کامل کاربر: نام + یوزرنیم + آیدی عددی — اگر پیام زنده یوزرنیم نداشت از دیتابیس پر می‌شود
  const dbu = await getUserByTg(tgId).catch(() => null);
  const label = userLabel({
    firstName: firstName ?? dbu?.firstName,
    username: username ?? dbu?.username,
    tgId,
  });
  const sub = await p.submission.create({
    data: {
      type: 'purchase',
      userTgId: tgId,
      userLabel: label,
      photoFileId: st.fileId,
      requestedPoints: st.points,
    },
  });
  // ارسال رسید به پنل مدیر (آپلود بایت‌ها — file_id بین ربات‌ها قابل انتقال نیست)
  const sent = await sendPhotoToPanel(
    st.fileId,
    `📥 ارسالی جدید — 💎 خرید امتیاز\n\n` +
      `👤 کاربر: ${label}\n` +
      `💎 امتیاز درخواستی: ${fmtNum(st.points)}\n` +
      `💳 مبلغ: ${fmtNum(st.toman)} تومان\n` +
      `⏰ ${faTime(new Date())}`,
    {
      inline_keyboard: [
        [
          { text: '✅ تایید', callback_data: `s_ok:${sub.id}` },
          { text: '❌ لغو', callback_data: `s_no:${sub.id}` },
        ],
        [{ text: '🗑 پاک کردن', callback_data: `s_del:${sub.id}` }],
      ],
    }
  );
  if (sent.ok && sent.messageId) {
    await p.submission.update({ where: { id: sub.id }, data: { adminMsgId: sent.messageId } });
  } else {
    await p.submission
      .update({ where: { id: sub.id }, data: { status: 'error', resolvedAt: new Date() } })
      .catch(() => {});
    log(`ارسال رسید خرید به پنل ناموفق: ${sent.error} — کاربر باید دوباره تلاش کند`);
    await sendMessage(
      chatId,
      '⚠️ ارسال رسید موقتاً ناموفق بود!\n\nچند لحظه بعد دوباره از منوی خرید امتیاز تلاش کن 🙏',
      MAIN_KEYBOARD
    );
    return;
  }
  userStates.delete(chatId);
  await sendMessage(
    chatId,
    '✅ رسیدت ارسال شد!\n\nبعد از تایید پشتیبانی، امتیازها به حسابت اضافه می‌شه و همین‌جا بهت خبر می‌دیم 🙏',
    MAIN_KEYBOARD
  );
}

// ---------- حساب کاربری ----------
async function sendAccount(chatId: number, firstName?: string, username?: string) {
  const u = await getUserByTg(String(chatId));
  const un = username || u?.username || null; // یوزرنیم زنده یا ذخیره‌شده در دیتابیس
  await sendMessage(
    chatId,
    `👤 حساب کاربری

👤 نام: ${u?.firstName || firstName || '—'}
🆔 آیدی عددی: ${chatId}${un ? `\n🔗 یوزرنیم: @${un}` : ''}
💎 امتیاز: ${fmtNum(u?.points ?? 0)}
🎯 شرکت در قرعه‌کشی‌ها: ${fmtNum(u?.lotteries ?? 0)} بار
🏆 برنده شدن: ${fmtNum(u?.wins ?? 0)} بار${u?.phone ? `\n📱 شماره: ${u.phone}` : ''}`,
    MAIN_KEYBOARD
  );
}

// ---------- شماره تلفن (پس از پاداش اینترنت) ----------
/** توسط پنل مدیر (@HmganBot) صدا زده می‌شود تا کاربر شماره‌اش را بفرستد */
export function beginPhoneFlow(chatId: number) {
  userStates.set(chatId, { kind: 'phone' });
  sendMessage(
    chatId,
    `🎉 پاداش اینترنت شما تایید شد!\n\n🌐 برای فعال‌سازی اینترنت رایگان، با دکمه زیر شماره تلفن خود را ارسال کنید 👇\n\n(یا شماره را به صورت متن بنویس، مثلاً 09123456789)`,
    PHONE_KB
  ).catch(() => {});
}

/** آیا متن شبیه شماره تلفن است؟ — تا دکمه‌های منو در حالت phone مسدود نشوند */
function looksLikePhone(s: string): boolean {
  const en = toEnDigits(s).replace(/[\s\-().]/g, '');
  return /^\+?\d{10,14}$/.test(en);
}

async function handlePhoneInput(chatId: number, rawPhone: string) {
  const digits = toEnDigits(rawPhone).replace(/[^\d+]/g, '');
  let onlyDigits = digits.replace(/\D/g, '');
  if (onlyDigits.startsWith('98') && onlyDigits.length === 12) onlyDigits = `0${onlyDigits.slice(2)}`; // 98912… → 0912…
  if (onlyDigits.length < 10 || onlyDigits.length > 14) {
    await sendMessage(
      chatId,
      '📱 شماره معتبر نیست — با دکمه «📱 ارسال شماره تلفن» بفرست، یا به صورت متن بنویس (مثلاً 09123456789):'
    );
    return;
  }
  let st = userStates.get(chatId);
  if (st?.kind !== 'phone') {
    st = { kind: 'phone' };
    userStates.set(chatId, st);
  }
  st.phone = onlyDigits;
  await sendMessage(
    chatId,
    `📞 شماره شما:\n${onlyDigits}\n\nاین شماره برای فعال‌سازی اینترنت به پشتیبانی ارسال شود؟`,
    PHOTO_CONFIRM_KB('ph_ok')
  );
}

async function submitPhone(chatId: number) {
  const st = userStates.get(chatId);
  if (st?.kind !== 'phone' || !st.phone) {
    userStates.delete(chatId);
    await sendMessage(chatId, '⏳ مهلت این درخواست گذشت — لطفاً دوباره شماره‌ت رو بفرست 🙏', MAIN_KEYBOARD);
    return;
  }
  const { p, userLabel } = await import('./wifto-db');
  const tgId = String(chatId);
  await p.botUser.update({ where: { tgId }, data: { phone: st.phone } }).catch(() => {});
  // آخرین ارسالیِ تاییدشدهِ در انتظار شماره را پیدا کن (برای مرجع)
  const sub = await p.submission.findFirst({
    where: { userTgId: tgId, awardMode: 'internet', status: 'approved' },
    orderBy: { resolvedAt: 'desc' },
  });
  if (sub && !sub.phone) {
    await p.submission.update({ where: { id: sub.id }, data: { phone: st.phone } });
  }
  const dbu = await p.botUser.findUnique({ where: { tgId } }).catch(() => null); // نام + یوزرنیم + آیدی
  await tgAdmin(
    'sendMessage',
    {
      chat_id: OWNER_CHAT_ID,
      text:
        `📞 شماره تلفن کاربر برای فعال‌سازی اینترنت:\n\n` +
        `👤 ${dbu ? userLabel(dbu) : (sub?.userLabel ?? `🆔 ${tgId}`)}\n` +
        `📱 شماره: ${st.phone}\n` +
        (sub?.missionTitle ? `🎯 ماموریت: ${sub.missionTitle}\n` : '') +
        `⏰ ${faTime(new Date())}`,
    },
    3
  );
  userStates.delete(chatId);
  await sendMessage(chatId, '✅ شماره‌ت ثبت شد!\n\nاینترنت به‌زودی برات فعال می‌شه 🌐🙏', MAIN_KEYBOARD);
}

// ---------- پیام‌ها ----------
async function handleMessage(msg: TgMsg) {
  const chatId = msg.chat?.id;
  if (!chatId) return;
  if (msg.from?.is_bot) return;

  // فقط چت خصوصی — گروه‌ها بی‌پاسخ
  const isGroup = msg.chat?.type === 'group' || msg.chat?.type === 'supergroup';
  if (isGroup) return;

  const text = (msg.text || '').trim();
  const firstName = msg.from?.first_name;
  const username = msg.from?.username;

  if (tooFast(chatId)) return; // اسپم را بی‌صدا رد کن
  registerUser(chatId, username, firstName);
  await ensureUser(String(chatId), firstName, username).catch(() => {});

  // ---------- فرمان‌های مدیر (ابزار مدیریت — بدون AI) ----------
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
    const { p } = await import('./wifto-db');
    const totalUsers = await p.botUser.count();
    await sendMessage(
      chatId,
      `📊 آمار ربات:\n👥 کل کاربران: ${seenUsers.size} (در دیتابیس: ${totalUsers})\n🔥 فعال ۲۴ ساعت گذشته: ${active24h}`
    );
    return;
  }

  // ---------- عکس ----------
  if (msg.photo?.length) {
    const st = userStates.get(chatId);
    const fileId = msg.photo[msg.photo.length - 1].file_id;
    if (st?.kind === 'mission_photo') {
      st.fileId = fileId;
      await sendMessage(chatId, `🖼 عکس دریافت شد.\n\nمی‌خوای ارسالش کنی؟`, PHOTO_CONFIRM_KB('ms_ok'));
      return;
    }
    if (st?.kind === 'buy_receipt') {
      st.fileId = fileId;
      await sendMessage(chatId, `🧾 عکس رسید دریافت شد.\n\nمی‌خوای ارسالش کنی؟`, PHOTO_CONFIRM_KB('buy_ok'));
      return;
    }
    await sendMessage(
      chatId,
      '📸 برای ارسال عکس، اول از منو «🎯 ماموریت‌ها» یا «💎 خرید امتیاز» رو انتخاب کن 👇',
      MAIN_KEYBOARD
    );
    return;
  }

  // ---------- شماره تماس (اشتراک مخاطب — دکمه request_contact) ----------
  if (msg.contact?.phone_number) {
    await handlePhoneInput(chatId, msg.contact.phone_number);
    return;
  }

  if (text === '/start' || text === '/help') {
    userStates.delete(chatId);
    await sendMessage(chatId, WELCOME(firstName), MAIN_KEYBOARD);
    return;
  }

  if (text === 'انصراف' || text === '/cancel') {
    userStates.delete(chatId);
    await sendMessage(chatId, `باشه، لغو شد 👌\n\n${MENU_HINT}`, MAIN_KEYBOARD);
    return;
  }

  const st = userStates.get(chatId);

  // ---------- جریان‌های فعال ----------
  if (st?.kind === 'phone' && text && looksLikePhone(text)) {
    await handlePhoneInput(chatId, text);
    return;
  }
  if (st?.kind === 'buy_amount' && text) {
    await handleBuyAmount(chatId, text);
    return;
  }
  if (st?.kind === 'mission_photo') {
    await sendMessage(chatId, '📸 لطفاً عکس (اسکرین‌شات) بفرست، یا «انصراف» را بزن:');
    return;
  }
  if (st?.kind === 'buy_receipt') {
    await sendMessage(chatId, '🧾 لطفاً عکس رسید پرداخت را بفرست، یا «انصراف» را بزن:');
    return;
  }

  if (!text) {
    await sendMessage(chatId, MENU_HINT, MAIN_KEYBOARD);
    return;
  }

  // ---------- منوی اصلی ----------
  switch (text) {
    case '🎯 ماموریت‌ها':
      await sendMissionsList(chatId);
      return;
    case '🎰 قرعه‌کشی':
      await sendLotteryPage(chatId);
      return;
    case '💎 خرید امتیاز':
      await startBuy(chatId);
      return;
    case '👤 حساب کاربری':
      await sendAccount(chatId, firstName, username);
      return;
    case '🎧 پشتیبانی':
      await sendMessage(chatId, SUPPORT_TEXT, MAIN_KEYBOARD);
      return;
  }

  await sendMessage(chatId, MENU_HINT, MAIN_KEYBOARD);
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
  await ensureUser(String(chatId), cb.from?.first_name, cb.from?.username).catch(() => {});

  // همیشه callback را پاس بده تا چرخ‌دنگ دکمه بایستد
  const answer = (text?: string) =>
    tg('answerCallbackQuery', { callback_query_id: cb.id, text }).catch(() => {});

  const data = cb.data ?? '';
  const firstName = cb.from?.first_name;
  const username = cb.from?.username;

  switch (true) {
    case data === 'mlist':
      await answer();
      await sendMissionsList(chatId);
      return;
    case data.startsWith('m:'):
      await answer();
      await sendMissionDetail(chatId, data.slice(2));
      return;
    case data.startsWith('ms:'):
      await answer('📸 بفرست!');
      await startMissionPhoto(chatId, data.slice(3));
      return;
    case data === 'ms_ok': {
      await answer('در حال ارسال...');
      await submitMissionPhoto(chatId, firstName, username);
      return;
    }
    case data === 'lot_join':
      await answer('🎟');
      await askLotteryJoin(chatId);
      return;
    case data === 'lot_yes':
      await answer('در حال ثبت...');
      await confirmLotteryJoin(chatId);
      return;
    case data === 'buy_ask':
      await answer('📸 عکس رسید رو بفرست');
      await sendMessage(chatId, '🧾 عکس رسید پرداخت رو همین‌جا بفرست:', {
        inline_keyboard: [[{ text: '❌ انصراف', callback_data: 'xst' }]],
      });
      return;
    case data === 'buy_ok': {
      await answer('در حال ارسال...');
      await submitPurchaseReceipt(chatId, firstName, username);
      return;
    }
    case data === 'ph_ok':
      await answer('در حال ثبت...');
      await submitPhone(chatId);
      return;
    case data === 'xst':
      userStates.delete(chatId);
      await answer('لغو شد');
      await sendMessage(chatId, `باشه، لغو شد 👌\n\n${MENU_HINT}`, MAIN_KEYBOARD);
      return;
    case data === 'about' || data === 'start_chat' || data === 'make_image' || data === 'clear_chat':
      // دکمه‌های نسخه‌های قبلی که هنوز در چت‌های قدیمی موجود است
      await answer();
      await sendMessage(chatId, MENU_HINT, MAIN_KEYBOARD);
      return;
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
  log('✅ WiftoBot روشن شد — long polling شروع شد (ماموریت/قرعه‌کشی/خرید امتیاز — بدون AI)');
  pollLoop().catch((e) => log(`خطای حلقه polling: ${(e as Error).message}`));

  // اطلاع‌رسانی به کاربر اصلی که ربات آنلاین است (فقط حالت polling)
  setTimeout(() => {
    sendMessage(
      OWNER_CHAT_ID,
      '🤖 WiftoBot روشن شد! ✅\n\n🎯 ماموریت‌ها | 🎰 قرعه‌کشی | 💎 خرید امتیاز | 👤 حساب کاربری | 🎧 پشتیبانی\n\nسیستم کامل آماده است — پنل مدیریت هم در @HmganBot فعال شد.'
    ).catch(() => {});
  }, 2000);
}
