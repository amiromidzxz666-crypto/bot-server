// ============================================================
// ربات پنل مدیریت Wifto (@HmganBot) — ربات شخصی مالک
// بخش‌ها: پیام همگانی به گروه‌ها + مدیریت ماموریت‌ها + قرعه‌کشی
//          + بررسی ارسالی‌ها (تایید/لغو/امتیاز/اینترنت/شماره) + آمار
// ============================================================
import { readFileSync } from 'node:fs';
import { TOKEN as MAIN_TOKEN, beginPhoneFlow } from './telegram-bot';
import {
  p,
  faTime,
  fmtNum,
  toEnDigits,
  userLabel,
  addPoints,
} from './wifto-db';

const TOKEN = process.env.TG_ADMIN_BOT_TOKEN ?? '';
const API = `https://api.telegram.org/bot${TOKEN}`;
const MAIN_API = `https://api.telegram.org/bot${MAIN_TOKEN}`;
const OWNER_CHAT_ID = process.env.OWNER_TG_CHAT_ID ? Number(process.env.OWNER_TG_CHAT_ID) : 0; // از Secrets
const GROUPS_FILE = `${process.env.DATA_DIR ?? '/app/db'}/tg-groups.json`;
const TG_LIMIT = 4000;

const WELCOME = `🎛️ سلام رئیس! پنل مدیریت Wifto خوش اومدی.

📢 پیام همگانی به گروه‌ها
🎯 ساخت و مدیریت ماموریت‌ها
🎰 برگزاری قرعه‌کشی و اعلام برنده
📥 بررسی ارسالی‌های کاربران (تایید/لغو)
📊 آمار کلی

از منوی زیر انتخاب کن 👇`;

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
        result?: { message_id?: number };
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

/** ارسال پیام به کاربر ربات اصلی با توکن ربات اصلی (@WiftoBot) */
async function sendUser(chatId: string | number, text: string) {
  for (let i = 0; i <= 2; i++) {
    try {
      const res = await fetch(`${MAIN_API}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text }),
      });
      const data = (await res.json()) as { ok: boolean; description?: string; parameters?: { retry_after?: number } };
      if (data.ok) return true;
      if (data.parameters?.retry_after) {
        await sleep((data.parameters.retry_after + 1) * 1000);
        continue;
      }
      log(`ارسال به کاربر ${chatId} ناموفق: ${data.description ?? '?'}`);
      return false;
    } catch (e) {
      log(`خطای شبکه ارسال به کاربر: ${(e as Error).message}`);
      await sleep(1500);
    }
  }
  return false;
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

const ADMIN_KB = {
  keyboard: [
    [{ text: '📢 پیام همگانی' }],
    [{ text: '🎯 ماموریت‌ها' }, { text: '🎰 قرعه‌کشی' }],
    [{ text: '📥 ارسالی‌ها' }, { text: '📊 آمار' }],
  ],
  resize_keyboard: true,
  is_persistent: true,
};

const BACK_KB = {
  inline_keyboard: [[{ text: '🔙 بازگشت به پنل', callback_data: 'home' }]],
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
type MissionDraft = {
  title: string;
  desc: string;
  howTo: string;
  rewardType: 'points' | 'internet';
  rewardPoints?: number;
};

type AdminState =
  | { kind: 'bc' } // مالک در حال نوشتن متن پیام همگانی است
  | { kind: 'm_title' }
  | { kind: 'm_desc'; title: string }
  | { kind: 'm_howto'; title: string; desc: string }
  | { kind: 'm_reward'; draft: MissionDraft }
  | { kind: 'm_points'; draft: MissionDraft }
  | { kind: 'lot_text' }
  | { kind: 'lot_confirm'; text: string }
  | { kind: 'lot_manual' }
  | { kind: 'award'; subId: string }
  | { kind: 'reject'; subId: string };

const adminStates = new Map<number, AdminState>();
const pendingBroadcast = new Map<number, string>(); // متن در انتظار تأیید

function clearStates(chatId: number) {
  adminStates.delete(chatId);
  pendingBroadcast.delete(chatId);
}

const CONFIRM_KEYBOARD = {
  inline_keyboard: [
    [
      { text: '✅ ارسال کن', callback_data: 'send_broadcast' },
      { text: '❌ لغو', callback_data: 'cancel_broadcast' },
    ],
  ],
};

// ---------- پنل ماموریت‌ها ----------
async function missionsPanel(chatId: number) {
  const missions = await p.mission.findMany({ orderBy: { createdAt: 'desc' } });
  let text = `🎯 مدیریت ماموریت‌ها\n\nتعداد کل: ${missions.length} ماموریت`;
  const rows: { text: string; callback_data: string }[][] = [
    [{ text: '➕ ماموریت جدید', callback_data: 'm_new' }],
  ];
  if (!missions.length) {
    text += '\n\nهنوز ماموریتی نساخته‌ای — با دکمه پایین اولین ماموریت رو بساز 👇';
  } else {
    text += '\n\nروی هر ماموریت بزن تا جزئیاتش رو ببینی:';
    for (const m of missions) {
      rows.push([
        {
          text: `${m.active ? '🟢' : '⚪'} ${m.title}`,
          callback_data: `mview:${m.id}`,
        },
      ]);
    }
  }
  rows.push([{ text: '🔙 بازگشت به پنل', callback_data: 'home' }]);
  await sendMessage(chatId, text, { inline_keyboard: rows });
}

async function missionView(chatId: number, id: string) {
  const m = await p.mission.findUnique({ where: { id } });
  if (!m) {
    await sendMessage(chatId, 'ماموریت پیدا نشد 🤔', BACK_KB);
    return;
  }
  const subCount = await p.submission.count({ where: { missionId: id } });
  await sendMessage(
    chatId,
    `🎯 ${m.title}\n\n📝 توضیحات:\n${m.description}\n\n📋 نحوه انجام و اسکرین‌شات:\n${m.howTo}\n\n🎁 پاداش: ${
      m.rewardType === 'internet' ? '🌐 اینترنت رایگان' : `💎 ${fmtNum(m.rewardPoints ?? 0)} امتیاز`
    }\n\n${m.active ? '🟢 فعال' : '⚪ غیرفعال'} | 📥 ارسالی‌ها: ${subCount}`,
    {
      inline_keyboard: [
        [
          { text: m.active ? '🚫 غیرفعال کن' : '✅ فعال کن', callback_data: `mtog:${m.id}` },
          { text: '🗑 حذف', callback_data: `mdel:${m.id}` },
        ],
        [{ text: '🔙 بازگشت', callback_data: 'pm' }],
      ],
    }
  );
}

// ---------- پنل قرعه‌کشی ----------
async function lotteryPanel(chatId: number) {
  const lot = await p.lottery.findFirst({ where: { status: 'open' }, orderBy: { createdAt: 'desc' } });
  let text = `🎰 مدیریت قرعه‌کشی\n\n`;
  if (lot) {
    const entries = await p.lotteryEntry.findMany({ where: { lotteryId: lot.id } });
    const total = entries.reduce((s, e) => s + e.points, 0);
    text += `🟢 یک قرعه‌کشی فعال داری:\n\n« ${lot.title.slice(0, 200)} »\n\n🎟 شرکت‌کننده: ${entries.length} نفر\n💎 مجموع امتیازها: ${fmtNum(total)}\n⏰ شروع: ${faTime(lot.createdAt)}`;
  } else {
    text += `فعلاً قرعه‌کشی فعالی نداری.\nبا «➕ قرعه‌کشی جدید» یکی برگزار کن 👇`;
  }
  await sendMessage(chatId, text, {
    inline_keyboard: [
      [
        { text: '➕ قرعه‌کشی جدید', callback_data: 'lot_new' },
        { text: '📋 وضعیت', callback_data: 'lot_info' },
      ],
      [
        { text: '🎲 برنده شانسی', callback_data: 'lot_draw' },
        { text: '✍️ برنده دستی', callback_data: 'lot_manual' },
      ],
      [{ text: '🏁 پایان قرعه‌کشی (بدون برنده)', callback_data: 'lot_end' }],
      [{ text: '🔙 بازگشت به پنل', callback_data: 'home' }],
    ],
  });
}

async function drawWinner(lotteryId: string, winnerTgId?: string) {
  const lot = await p.lottery.findUnique({ where: { id: lotteryId } });
  if (!lot) return { ok: false, msg: 'قرعه‌کشی پیدا نشد 🤔' };

  const entries = await p.lotteryEntry.findMany({ where: { lotteryId } });
  if (!entries.length) return { ok: false, msg: 'هنوز کسی در این قرعه‌کشی شرکت نکرده 😅' };

  let win: { userTgId: string; points: number };
  if (winnerTgId) {
    const found = entries.find((e) => e.userTgId === winnerTgId);
    if (!found) return { ok: false, msg: `کاربر ${winnerTgId} در این قرعه‌کشی شرکت نکرده ❌` };
    win = { userTgId: found.userTgId, points: found.points };
  } else {
    // شانس وزنی — امتیاز بیشتر = شانس بیشتر
    const total = entries.reduce((s, e) => s + e.points, 0);
    let r = Math.random() * total;
    let picked = entries[entries.length - 1];
    for (const e of entries) {
      r -= e.points;
      if (r <= 0) {
        picked = e;
        break;
      }
    }
    win = { userTgId: picked.userTgId, points: picked.points };
  }

  const wu = await p.botUser.findUnique({ where: { tgId: win.userTgId } });
  await p.$transaction([
    p.lottery.update({
      where: { id: lotteryId },
      data: { status: 'drawn', winnerTgId: win.userTgId, endedAt: new Date() },
    }),
    p.botUser.update({ where: { tgId: win.userTgId }, data: { wins: { increment: 1 } } }),
  ]);

  // اطلاع به برنده با ربات اصلی
  const name = wu?.firstName?.trim() || 'دوست عزیز';
  await sendUser(
    win.userTgId,
    `🏆 تبریک ${name}!\n\nشما برنده قرعه‌کشی شدی! 🎉\n\n🎰 قرعه‌کشی: ${lot.title.slice(0, 150)}\n💎 با ${fmtNum(win.points)} امتیاز برنده شدی\n\nبرای دریافت جایزه با پشتیبانی در ارتباط باش:\n@Notification_Wifto`
  );

  const label = wu
    ? userLabel(wu)
    : `🆔 ${win.userTgId}`;
  return {
    ok: true,
    msg:
      `🏆 برنده قرعه‌کشی اعلام شد!\n\n👤 برنده: ${label}\n💎 امتیاز در قرعه‌کشی: ${fmtNum(win.points)}\n🎟 تعداد شرکت‌کننده: ${entries.length}\n\n✅ پیام تبریک برایش ارسال شد.`,
  };
}

// ---------- ارسالی‌ها ----------
/** برچسب کامل و تازه کاربر (نام + @یوزرنیم + آیدی عددی) — از دیتابیس؛ اگر کاربر در دیتابیس نبود از لیبل ذخیره‌شده */
async function userLabelFresh(userTgId: string, stored?: string): Promise<string> {
  try {
    const wu = await p.botUser.findUnique({ where: { tgId: userTgId } });
    if (wu) return userLabel(wu);
  } catch {}
  return stored ?? `🆔 ${userTgId}`;
}

function subCaption(
  sub: {
    type: string;
    userLabel: string;
    missionTitle?: string | null;
    requestedPoints?: number | null;
    awardMode?: string | null;
    awardedPoints?: number | null;
    phone?: string | null;
    status: string;
    createdAt: Date;
  },
  extra?: string
): string {
  let c =
    `📥 ارسالی — ${sub.type === 'purchase' ? '💎 خرید امتیاز' : '🎯 ماموریت'}\n\n` +
    `👤 کاربر: ${sub.userLabel}\n`;
  if (sub.missionTitle) c += `🎯 ماموریت: ${sub.missionTitle}\n`;
  if (sub.type === 'purchase' && sub.requestedPoints)
    c += `💎 امتیاز درخواستی: ${fmtNum(sub.requestedPoints)} (${fmtNum(sub.requestedPoints * 1000)} تومان)\n`;
  c += `⏰ ${faTime(sub.createdAt)}\n\n`;
  if (sub.status === 'approved') {
    c += sub.awardMode === 'internet'
      ? `✅ تایید شد — پاداش: 🌐 اینترنت${sub.phone ? `\n📱 شماره: ${sub.phone}` : ''}`
      : `✅ تایید شد — ${fmtNum(sub.awardedPoints ?? 0)} امتیاز واریز شد`;
  } else if (sub.status === 'rejected') {
    c += `❌ لغو شد`;
  } else {
    c += `⏳ در انتظار بررسی`;
  }
  if (extra) c += `\n\n${extra}`;
  return c;
}

async function submissionsPanel(chatId: number) {
  const subs = await p.submission.findMany({ orderBy: { createdAt: 'desc' }, take: 15 });
  const pendingCount = await p.submission.count({ where: { status: 'pending' } });
  let text = `📥 ارسالی‌ها (۱۵ مورد آخر)\n\n⏳ در انتظار بررسی: ${pendingCount}\n\nعکس‌های کاربران خودکار همین‌جا ارسال می‌شوند و زیر هر عکس دکمه تایید/لغو دارید.\n\n`;
  const viewRows: { text: string; callback_data: string }[][] = [];
  if (!subs.length) text += `هنوز هیچ ارسالی ثبت نشده.`;
  else {
    for (const s of subs) {
      const icon = s.status === 'approved' ? '✅' : s.status === 'rejected' ? '❌' : '⏳';
      const label = await userLabelFresh(s.userTgId, s.userLabel); // نام + @یوزرنیم + آیدی عددی
      text += `${icon} ${s.type === 'purchase' ? '💎 خرید' : '🎯 ماموریت'} — ${label} — ${faTime(s.createdAt)}\n`;
      // برای ارسالی‌های در انتظار، دکمه نمایش مجدد عکس (اگر پیام عکس حذف/نرسیده باشد)
      if (s.status === 'pending')
        viewRows.push([
          {
            text: `🖼 نمایش عکس — ${s.type === 'purchase' ? '💎 خرید' : '🎯 ماموریت'} (${label.split(' — ')[0]})`,
            callback_data: `s_view:${s.id}`,
          },
        ]);
    }
  }
  if (viewRows.length) viewRows.push([{ text: '🔄 بروزرسانی لیست', callback_data: 'ps' }]);
  await sendMessage(chatId, text, viewRows.length ? { inline_keyboard: viewRows } : BACK_KB);
}

/** بروزرسانی کپشن پیام عکس در چت مدیر بعد از تایید/لغو */
async function updateSubmissionMessage(sub: { id: string; userTgId: string; adminMsgId?: number | null; status: string; awardMode?: string | null; awardedPoints?: number | null; phone?: string | null; type: string; userLabel: string; missionTitle?: string | null; requestedPoints?: number | null; createdAt: Date }) {
  if (!sub.adminMsgId) return;
  const label = await userLabelFresh(sub.userTgId, sub.userLabel);
  await tg('editMessageCaption', {
    chat_id: OWNER_CHAT_ID,
    message_id: sub.adminMsgId,
    caption: subCaption({ ...sub, userLabel: label }),
    reply_markup: {
      inline_keyboard: [[{ text: '🗑 پاک کردن', callback_data: `s_del:${sub.id}` }]],
    },
  }).catch(() => {});
}

/** نمایش مجدد عکس یک ارسالی در چت مدیر (اگر پیام اصلی حذف شده یا نرسیده باشد)
 *  file_id کاربر متعلق به ربات اصلی است — بایت‌ها با توکن اصلی گرفته و به API پنل آپلود می‌شود */
async function resendSubmissionPhoto(sub: {
  id: string;
  userTgId: string;
  photoFileId: string;
  type: string;
  userLabel: string;
  missionTitle?: string | null;
  requestedPoints?: number | null;
  status: string;
  awardMode?: string | null;
  awardedPoints?: number | null;
  phone?: string | null;
  createdAt: Date;
}): Promise<boolean> {
  try {
    const g = (await fetch(`https://api.telegram.org/bot${MAIN_TOKEN}/getFile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file_id: sub.photoFileId }),
      signal: AbortSignal.timeout(15_000),
    }).then((r) => r.json())) as { ok: boolean; result?: { file_path?: string } };
    if (!g.ok || !g.result?.file_path) {
      log(`getFile ارسالی ${sub.id} ناموفق بود`);
      return false;
    }
    const res = await fetch(`https://api.telegram.org/file/bot${MAIN_TOKEN}/${g.result.file_path}`, {
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      log(`دانلود عکس ارسالی ${sub.id}: HTTP ${res.status}`);
      return false;
    }
    const bytes = await res.arrayBuffer();
    const label = await userLabelFresh(sub.userTgId, sub.userLabel); // نام + @یوزرنیم + آیدی عددی
    const kb =
      sub.status === 'pending'
        ? {
            inline_keyboard: [
              [
                { text: '✅ تایید', callback_data: `s_ok:${sub.id}` },
                { text: '❌ لغو', callback_data: `s_no:${sub.id}` },
              ],
              [{ text: '🗑 پاک کردن', callback_data: `s_del:${sub.id}` }],
            ],
          }
        : { inline_keyboard: [[{ text: '🗑 پاک کردن', callback_data: `s_del:${sub.id}` }]] };
    const form = new FormData();
    form.append('chat_id', String(OWNER_CHAT_ID));
    form.append('caption', subCaption({ ...sub, userLabel: label }).slice(0, 1024));
    form.append('reply_markup', JSON.stringify(kb));
    form.append('photo', new Blob([bytes], { type: 'image/jpeg' }), 'photo.jpg');
    const up = await fetch(`${API}/sendPhoto`, { method: 'POST', body: form });
    const data = (await up.json()) as {
      ok: boolean;
      result?: { message_id?: number };
      description?: string;
    };
    if (data.ok && data.result?.message_id) {
      await p.submission.update({ where: { id: sub.id }, data: { adminMsgId: data.result.message_id } });
      return true;
    }
    log(`sendPhoto مجدد ارسالی ${sub.id}: ${data.description ?? '?'}`);
    return false;
  } catch (e) {
    log(`خطای نمایش ارسالی ${sub.id}: ${(e as Error).message}`);
    return false;
  }
}

// ---------- آمار ----------
async function statsPanel(chatId: number) {
  const [users, totalPoints, pending, missions, entries] = await Promise.all([
    p.botUser.count(),
    p.botUser.aggregate({ _sum: { points: true } }),
    p.submission.count({ where: { status: 'pending' } }),
    p.mission.count({ where: { active: true } }),
    p.lotteryEntry.count({ where: { lottery: { status: 'open' } } }),
  ]);
  await sendMessage(
    chatId,
    `📊 آمار Wifto\n\n👥 کاربران: ${fmtNum(users)}\n💎 مجموع امتیازها: ${fmtNum(totalPoints._sum.points ?? 0)}\n🎯 ماموریت‌های فعال: ${fmtNum(missions)}\n⏳ ارسالی در انتظار بررسی: ${fmtNum(pending)}\n🎟 شرکت‌کنندگان قرعه‌کشی فعال: ${fmtNum(entries)}`,
    BACK_KB
  );
}

// ---------- پردازش پیام ----------
type AdminMsg = {
  chat?: { id?: number; type?: string };
  from?: { is_bot?: boolean; username?: string; first_name?: string };
  date?: number;
  text?: string;
};

function parsePointsOrInternet(text: string): { mode: 'points' | 'internet'; points?: number } | null {
  const t = text.trim();
  if (t === 'اینترنت' || t === 'internet' || t === '🌐' || t === '🌐 اینترنت') {
    return { mode: 'internet' };
  }
  const n = parseInt(toEnDigits(t).replace(/[^\d]/g, ''), 10);
  if (n && n > 0 && n <= 1000000) return { mode: 'points', points: n };
  return null;
}

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

  if (text === '/start' || text === '/help') {
    clearStates(chatId);
    await sendMessage(chatId, WELCOME, ADMIN_KB);
    return;
  }

  if (text === 'انصراف' || text === '/cancel' || text === '/skip') {
    const st = adminStates.get(chatId);
    // برای لغو ارسالی، /skip یعنی «بدون پیام»
    if (st?.kind === 'reject' && text === '/skip') {
      await resolveReject(chatId, st.subId, null);
      return;
    }
    clearStates(chatId);
    await sendMessage(chatId, 'باشه، لغو شد 👌', ADMIN_KB);
    return;
  }

  if (!text) return;

  const st = adminStates.get(chatId);

  // ---------- حالت‌های فعال ----------
  if (st) {
    switch (st.kind) {
      case 'bc': {
        adminStates.delete(chatId);
        pendingBroadcast.set(chatId, text);
        const groups = loadGroups();
        await sendMessage(
          chatId,
          `📢 متن پیامت:\n\n« ${text} »\n\n🎯 مقصد: ${groups.length} گروه فعال\n\nارسال کنم؟`,
          CONFIRM_KEYBOARD
        );
        return;
      }
      case 'm_title': {
        adminStates.set(chatId, { kind: 'm_desc', title: text });
        await sendMessage(chatId, `📝 عنوان: « ${text} »\n\nحالا توضیحات ماموریت رو بنویس:`);
        return;
      }
      case 'm_desc': {
        adminStates.set(chatId, { kind: 'm_howto', title: st.title, desc: text });
        await sendMessage(
          chatId,
          `📋 توضیحات ذخیره شد.\n\nحالا «نحوه انجام دادن ماموریت» رو بنویس — اینکه کاربر چه کاری باید بکنه و از کجای صفحه اسکرین‌شات بگیره:`
        );
        return;
      }
      case 'm_howto': {
        const draft: MissionDraft = { title: st.title, desc: st.desc, howTo: text, rewardType: 'points' };
        adminStates.set(chatId, { kind: 'm_reward', draft });
        await sendMessage(
          chatId,
          `🎁 پاداش این ماموریت چیه؟`,
          {
            inline_keyboard: [
              [
                { text: '💎 امتیاز', callback_data: 'rw_p' },
                { text: '🌐 اینترنت', callback_data: 'rw_i' },
              ],
            ],
          }
        );
        return;
      }
      case 'm_points': {
        const n = parseInt(toEnDigits(text).replace(/[^\d]/g, ''), 10);
        if (!n || n < 1 || n > 1000000) {
          await sendMessage(chatId, '⛔ مقدار امتیاز را با عدد انگلیسی بفرست (مثلاً 50):');
          return;
        }
        st.draft.rewardPoints = n;
        adminStates.set(chatId, { kind: 'm_reward', draft: st.draft });
        await confirmMissionDraft(chatId, st.draft);
        return;
      }
      case 'lot_text': {
        adminStates.set(chatId, { kind: 'lot_confirm', text });
        await sendMessage(
          chatId,
          `🎰 متن قرعه‌کشی:\n\n« ${text} »\n\nقرعه‌کشی رو با این توضیحات شروع کنم؟ (قرعه‌کشی فعال قبلی بسته می‌شه)`,
          {
            inline_keyboard: [
              [
                { text: '✅ شروع قرعه‌کشی', callback_data: 'lotcf' },
                { text: '❌ انصراف', callback_data: 'lotxl' },
              ],
            ],
          }
        );
        return;
      }
      case 'lot_confirm':
        await sendMessage(chatId, 'با دکمه‌های زیر ادامه بده 👇');
        return;
      case 'lot_manual': {
        const tgId = toEnDigits(text).replace(/\D/g, '');
        adminStates.delete(chatId);
        const lot = await p.lottery.findFirst({ where: { status: 'open' }, orderBy: { createdAt: 'desc' } });
        if (!lot) {
          await sendMessage(chatId, 'قرعه‌کشی فعالی وجود ندارد 🤔', BACK_KB);
          return;
        }
        const res = await drawWinner(lot.id, tgId);
        await sendMessage(chatId, res.msg, BACK_KB);
        return;
      }
      case 'award': {
        const parsed = parsePointsOrInternet(text);
        if (!parsed) {
          await sendMessage(
            chatId,
            '⛔ مقدار امتیاز را با عدد انگلیسی بفرست، یا برای پاداش اینترنت فقط بنویس: اینترنت'
          );
          return;
        }
        await resolveAward(chatId, st.subId, parsed.mode, parsed.points);
        return;
      }
      case 'reject': {
        await resolveReject(chatId, st.subId, text);
        return;
      }
    }
  }

  // ---------- دکمه‌های منو ----------
  switch (text) {
    case '📢 پیام همگانی': {
      clearStates(chatId);
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
      adminStates.set(chatId, { kind: 'bc' });
      return;
    }
    case '🎯 ماموریت‌ها':
      clearStates(chatId);
      await missionsPanel(chatId);
      return;
    case '🎰 قرعه‌کشی':
      clearStates(chatId);
      await lotteryPanel(chatId);
      return;
    case '📥 ارسالی‌ها':
      clearStates(chatId);
      await submissionsPanel(chatId);
      return;
    case '📊 آمار':
      clearStates(chatId);
      await statsPanel(chatId);
      return;
  }

  await sendMessage(chatId, 'از دکمه‌های منوی پایین استفاده کن 👇', ADMIN_KB);
}

async function confirmMissionDraft(chatId: number, d: MissionDraft) {
  const reward =
    d.rewardType === 'internet' ? '🌐 اینترنت رایگان' : `💎 ${fmtNum(d.rewardPoints ?? 0)} امتیاز`;
  await sendMessage(
    chatId,
    `🎯 ثبت ماموریت جدید\n\n📌 عنوان: ${d.title}\n\n📝 توضیحات:\n${d.desc}\n\n📋 نحوه انجام و اسکرین‌شات:\n${d.howTo}\n\n🎁 پاداش: ${reward}\n\nثبت کنم؟`,
    {
      inline_keyboard: [
        [
          { text: '✅ تایید و ثبت', callback_data: 'mcf' },
          { text: '❌ انصراف', callback_data: 'mxl' },
        ],
      ],
    }
  );
}

async function resolveAward(
  chatId: number,
  subId: string,
  mode: 'points' | 'internet',
  points?: number
) {
  adminStates.delete(chatId);
  const sub = await p.submission.findUnique({ where: { id: subId } });
  if (!sub) {
    await sendMessage(chatId, 'ارسالی پیدا نشد 🤔');
    return;
  }
  if (sub.status !== 'pending') {
    await sendMessage(chatId, `⚠️ این ارسالی قبلاً بررسی شده (${sub.status === 'approved' ? 'تایید' : 'لغو'}).`);
    return;
  }
  if (sub.type === 'purchase' && mode === 'internet') {
    await sendMessage(chatId, '⛔ برای خرید امتیاز فقط عدد امتیاز را بفرست.');
    adminStates.set(chatId, { kind: 'award', subId });
    return;
  }

  let notify: string;
  if (mode === 'internet') {
    await p.submission.update({
      where: { id: subId },
      data: { status: 'approved', awardMode: 'internet', resolvedAt: new Date() },
    });
    notify = `✅ ماموریت شما تایید شد! 🎉\n\nبرای اینکه اینترنت را برای شما فعال کنیم، شماره تلفن خود را ارسال کنید 📱`;
  } else {
    const n = points ?? 0;
    await p.submission.update({
      where: { id: subId },
      data: { status: 'approved', awardMode: 'points', awardedPoints: n, resolvedAt: new Date() },
    });
    await addPoints(sub.userTgId, n).catch(() => {});
    notify =
      sub.type === 'purchase'
        ? `✅ پرداخت شما تایید شد! 💎\n\n${fmtNum(n)} امتیاز به حسابتان اضافه شد.\n\nمی‌تونی امتیازت رو تو قرعه‌کشی شرکت بدی یا ماموریت‌های جدید انجام بدی 🍀`
        : `✅ ماموریت شما تایید شد! 🎉\n\n${fmtNum(n)} امتیاز به حسابتان اضافه شد.`;
  }

  const sent = await sendUser(sub.userTgId, notify);
  if (mode === 'internet') {
    beginPhoneFlow(Number(sub.userTgId)); // ربات اصلی از کاربر شماره می‌گیرد
  }
  const fresh = await p.submission.findUnique({ where: { id: subId } });
  if (fresh) await updateSubmissionMessage(fresh);
  const who = await userLabelFresh(sub.userTgId, sub.userLabel);
  await sendMessage(
    chatId,
    `✅ تایید و ثبت شد!\n\n👤 ${who}\n${mode === 'internet' ? '🌐 پاداش: اینترنت (منتظر شماره کاربر)' : `💎 ${fmtNum(points ?? 0)} امتیاز واریز شد`}\n📨 اطلاع‌رسانی به کاربر: ${sent ? 'انجام شد ✅' : 'ناموفق ⚠️'}`
  );
  log(`تایید ارسالی ${subId} — mode=${mode} points=${points ?? 0} user=${sub.userTgId}`);
}

async function resolveReject(chatId: number, subId: string, adminMsg: string | null) {
  adminStates.delete(chatId);
  const sub = await p.submission.findUnique({ where: { id: subId } });
  if (!sub) {
    await sendMessage(chatId, 'ارسالی پیدا نشد 🤔');
    return;
  }
  if (sub.status !== 'pending') {
    await sendMessage(chatId, `⚠️ این ارسالی قبلاً بررسی شده (${sub.status === 'approved' ? 'تایید' : 'لغو'}).`);
    return;
  }
  await p.submission.update({
    where: { id: subId },
    data: { status: 'rejected', resolvedAt: new Date() },
  });
  const kindFa = sub.type === 'purchase' ? 'درخواست خرید امتیاز' : 'ماموریت';
  let notify = `❌ ${kindFa} شما لغو شد.`;
  if (adminMsg && adminMsg !== '/skip') notify += `\n\n💬 پیام پشتیبانی:\n${adminMsg}`;
  const sent = await sendUser(sub.userTgId, notify);
  const fresh = await p.submission.findUnique({ where: { id: subId } });
  if (fresh) await updateSubmissionMessage(fresh);
  const who = await userLabelFresh(sub.userTgId, sub.userLabel);
  await sendMessage(
    chatId,
    `❌ لغو شد و کاربر مطلع گردید.\n\n👤 ${who}\n📨 ارسال پیام: ${sent ? 'انجام شد ✅' : 'ناموفق ⚠️'}`
  );
  log(`لغو ارسالی ${subId} user=${sub.userTgId}`);
}

// ---------- پردازش دکمه‌ها ----------
type AdminCallback = {
  id: string;
  data?: string;
  from?: { is_bot?: boolean; username?: string; first_name?: string };
  message?: { chat?: { id?: number }; message_id?: number; date?: number };
};

async function handleCallback(cb: AdminCallback) {
  const chatId = cb.message?.chat?.id;
  if (!chatId || chatId !== OWNER_CHAT_ID) return;

  const answer = (text?: string) => {
    tg('answerCallbackQuery', { callback_query_id: cb.id, text }).catch(() => {});
  };

  const data = cb.data ?? '';

  switch (true) {
    // ---------- پیام همگانی ----------
    case data === 'broadcast': {
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
      adminStates.set(chatId, { kind: 'bc' });
      return;
    }
    case data === 'send_broadcast': {
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
    case data === 'cancel_broadcast': {
      clearStates(chatId);
      await answer('لغو شد');
      await sendMessage(chatId, 'باشه، لغو شد 👌', ADMIN_KB);
      return;
    }

    // ---------- پنل ----------
    case data === 'home':
      clearStates(chatId);
      await answer();
      await sendMessage(chatId, '🎛️ پنل مدیریت Wifto', ADMIN_KB);
      return;

    // ---------- ماموریت‌ها ----------
    case data === 'pm':
      await answer();
      await missionsPanel(chatId);
      return;
    case data === 'm_new':
      await answer('🎯 بسازیم!');
      adminStates.set(chatId, { kind: 'm_title' });
      await sendMessage(
        chatId,
        '🆕 ماموریت جدید\n\n📌 عنوان ماموریت رو بنویس:\n\n(برای لغو بنویس: انصراف)'
      );
      return;
    case data === 'rw_p': {
      const st = adminStates.get(chatId);
      if (st?.kind !== 'm_reward') return await answer();
      await answer('💎 امتیاز');
      adminStates.set(chatId, { kind: 'm_points', draft: st.draft });
      await sendMessage(chatId, '💎 مقدار امتیاز پیشنهادی این ماموریت چند است؟ (با عدد انگلیسی بفرست، مثلاً 50):');
      return;
    }
    case data === 'rw_i': {
      const st = adminStates.get(chatId);
      if (st?.kind !== 'm_reward') return await answer();
      await answer('🌐 اینترنت');
      st.draft.rewardType = 'internet';
      st.draft.rewardPoints = undefined;
      await confirmMissionDraft(chatId, st.draft);
      return;
    }
    case data === 'mcf': {
      const st = adminStates.get(chatId);
      if (st?.kind !== 'm_reward') return await answer();
      const d = st.draft;
      const m = await p.mission.create({
        data: {
          title: d.title,
          description: d.desc,
          howTo: d.howTo,
          rewardType: d.rewardType,
          rewardPoints: d.rewardType === 'points' ? d.rewardPoints ?? 0 : null,
        },
      });
      adminStates.delete(chatId);
      await answer('✅ ثبت شد!');
      await sendMessage(
        chatId,
        `✅ ماموریت «${m.title}» ثبت شد و بلافاصله در لیست ماموریت‌های کاربران ظاهر می‌شود 🎯`
      );
      await missionsPanel(chatId);
      return;
    }
    case data === 'mxl': {
      clearStates(chatId);
      await answer('لغو شد');
      await sendMessage(chatId, 'ماموریت جدید لغو شد 👌', ADMIN_KB);
      return;
    }
    case data.startsWith('mview:'):
      await answer();
      await missionView(chatId, data.slice(6));
      return;
    case data.startsWith('mtog:'): {
      await answer();
      const m = await p.mission.findUnique({ where: { id: data.slice(5) } });
      if (!m) return;
      await p.mission.update({ where: { id: m.id }, data: { active: !m.active } });
      await sendMessage(chatId, m.active ? `🚫 «${m.title}» از لیست کاربران حذف (غیرفعال) شد.` : `✅ «${m.title}» دوباره فعال شد.`);
      return;
    }
    case data.startsWith('mdel:'): {
      await answer();
      const m = await p.mission.findUnique({ where: { id: data.slice(5) } });
      if (!m) return;
      await sendMessage(chatId, `🗑 «${m.title}» برای همیشه حذف شود؟ (ارسالی‌های قبلیش نگه داشته می‌شوند)`, {
        inline_keyboard: [
          [
            { text: '✅ بله، حذف کن', callback_data: `mdely:${m.id}` },
            { text: '❌ نه', callback_data: 'pm' },
          ],
        ],
      });
      return;
    }
    case data.startsWith('mdely:'): {
      await answer('حذف شد');
      const m = await p.mission.delete({ where: { id: data.slice(6) } }).catch(() => null);
      await sendMessage(chatId, m ? `🗑 ماموریت «${m.title}» حذف شد.` : 'ماموریت پیدا نشد 🤔');
      return;
    }

    // ---------- قرعه‌کشی ----------
    case data === 'pl':
      await answer();
      await lotteryPanel(chatId);
      return;
    case data === 'lot_new':
      await answer('🎰');
      adminStates.set(chatId, { kind: 'lot_text' });
      await sendMessage(
        chatId,
        '🆕 قرعه‌کشی جدید\n\n📝 توضیحات قرعه‌کشی رو بنویس (جایزه چیه، کِی کشیده می‌شه و...):\n\n(برای لغو بنویس: انصراف)'
      );
      return;
    case data === 'lotcf': {
      const st = adminStates.get(chatId);
      if (st?.kind !== 'lot_confirm') return await answer();
      await answer('🎰 شروع شد!');
      // بستن قرعه‌کشی‌های باز قبلی
      await p.lottery.updateMany({ where: { status: 'open' }, data: { status: 'closed', endedAt: new Date() } });
      const lot = await p.lottery.create({ data: { title: st.text } });
      adminStates.delete(chatId);
      await sendMessage(chatId, `✅ قرعه‌کشی جدید شروع شد!\n\n« ${lot.title.slice(0, 200)} »\n\nکاربران از منوی «🎰 قرعه‌کشی» می‌تونن شرکت کنن.`);
      return;
    }
    case data === 'lotxl': {
      clearStates(chatId);
      await answer('لغو شد');
      await sendMessage(chatId, 'قرعه‌کشی جدید لغو شد 👌', ADMIN_KB);
      return;
    }
    case data === 'lot_info': {
      await answer();
      const lot = await p.lottery.findFirst({ where: { status: 'open' }, orderBy: { createdAt: 'desc' } });
      if (!lot) {
        await sendMessage(chatId, 'قرعه‌کشی فعالی وجود ندارد 🤔', BACK_KB);
        return;
      }
      const entries = await p.lotteryEntry.findMany({
        where: { lotteryId: lot.id },
        orderBy: { points: 'desc' },
      });
      const total = entries.reduce((s, e) => s + e.points, 0);
      let t = `📋 وضعیت قرعه‌کشی\n\n« ${lot.title.slice(0, 200)} »\n\n🎟 شرکت‌کننده: ${entries.length} نفر | 💎 مجموع: ${fmtNum(total)} امتیاز\n\n`;
      if (entries.length) {
        t += 'برترین‌ها:\n';
        entries.slice(0, 10).forEach((e, i) => {
          t += `${i + 1}. 🆔 ${e.userTgId} — ${fmtNum(e.points)} امتیاز\n`;
        });
        if (entries.length > 10) t += `... و ${entries.length - 10} نفر دیگر`;
      } else {
        t += 'هنوز کسی شرکت نکرده.';
      }
      await sendMessage(chatId, t, BACK_KB);
      return;
    }
    case data === 'lot_draw': {
      await answer('🎲 دارم قرعه می‌کشم...');
      const lot = await p.lottery.findFirst({ where: { status: 'open' }, orderBy: { createdAt: 'desc' } });
      if (!lot) {
        await sendMessage(chatId, 'قرعه‌کشی فعالی وجود ندارد 🤔', BACK_KB);
        return;
      }
      const res = await drawWinner(lot.id);
      await sendMessage(chatId, res.msg, BACK_KB);
      return;
    }
    case data === 'lot_manual':
      await answer('✍️ آیدی برنده رو بفرست');
      adminStates.set(chatId, { kind: 'lot_manual' });
      await sendMessage(
        chatId,
        '✍️ آیدی عددی تلگرام برنده رو بفرست (همون عددی که تو «حساب کاربری» خودش می‌بینه):'
      );
      return;
    case data === 'lot_end': {
      await answer();
      const lot = await p.lottery.findFirst({ where: { status: 'open' }, orderBy: { createdAt: 'desc' } });
      if (!lot) {
        await sendMessage(chatId, 'قرعه‌کشی فعالی وجود ندارد 🤔', BACK_KB);
        return;
      }
      await p.lottery.update({ where: { id: lot.id }, data: { status: 'closed', endedAt: new Date() } });
      await sendMessage(chatId, '🏁 قرعه‌کشی بدون اعلام برنده بسته شد.', BACK_KB);
      return;
    }

    // ---------- ارسالی‌ها ----------
    case data === 'ps':
      await answer();
      await submissionsPanel(chatId);
      return;
    case data.startsWith('s_ok:'): {
      await answer('✅');
      const subId = data.slice(5);
      const sub = await p.submission.findUnique({ where: { id: subId } });
      if (!sub) {
        await sendMessage(chatId, 'ارسالی پیدا نشد 🤔');
        return;
      }
      if (sub.status !== 'pending') {
        await sendMessage(chatId, `⚠️ این ارسالی قبلاً بررسی شده (${sub.status === 'approved' ? 'تایید' : 'لغو'}).`);
        return;
      }
      const mission = sub.missionId ? await p.mission.findUnique({ where: { id: sub.missionId } }) : null;
      const suggestText =
        sub.type === 'purchase'
          ? `پیشنهاد بر اساس پرداخت: ${fmtNum(sub.requestedPoints ?? 0)} امتیاز`
          : mission
            ? mission.rewardType === 'internet'
              ? 'پاداش پیشنهادی ماموریت: 🌐 اینترنت'
              : `پاداش پیشنهادی ماموریت: ${fmtNum(mission.rewardPoints ?? 0)} امتیاز`
            : '';
      adminStates.set(chatId, { kind: 'award', subId });
      const who = await userLabelFresh(sub.userTgId, sub.userLabel);
      await sendMessage(
        chatId,
        `✅ تایید ارسالی کاربر:\n👤 ${who}\n\nمقدار امتیاز را با عدد انگلیسی بفرست، یا برای پاداش اینترنت فقط بنویس: اینترنت\n\n${suggestText}\n\n(برای لغو بنویس: انصراف)`
      );
      return;
    }
    case data.startsWith('s_no:'): {
      await answer('❌');
      const subId = data.slice(5);
      const sub = await p.submission.findUnique({ where: { id: subId } });
      if (!sub) {
        await sendMessage(chatId, 'ارسالی پیدا نشد 🤔');
        return;
      }
      if (sub.status !== 'pending') {
        await sendMessage(chatId, `⚠️ این ارسالی قبلاً بررسی شده (${sub.status === 'approved' ? 'تایید' : 'لغو'}).`);
        return;
      }
      adminStates.set(chatId, { kind: 'reject', subId });
      const who = await userLabelFresh(sub.userTgId, sub.userLabel);
      await sendMessage(
        chatId,
        `❌ لغو ارسالی کاربر:\n👤 ${who}\n\nپیامی برایش بنویس که اشتباهش رو بگه (یا /skip بدون پیام):`
      );
      return;
    }
    case data.startsWith('s_del:'): {
      await answer('پاک شد');
      const mid = cb.message?.message_id;
      if (mid) await tg('deleteMessage', { chat_id: chatId, message_id: mid }).catch(() => {});
      return;
    }
    case data.startsWith('s_view:'): {
      await answer('در حال دریافت عکس...');
      const subId = data.slice(7);
      const sub = await p.submission.findUnique({ where: { id: subId } });
      if (!sub) {
        await sendMessage(chatId, 'ارسالی پیدا نشد 🤔');
        return;
      }
      const ok = await resendSubmissionPhoto(sub);
      if (!ok)
        await sendMessage(
          chatId,
          '⚠️ نمایش عکس ناموفق بود — فایل ممکن است منقضی شده باشد یا در دسترس نباشد.'
        );
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
  log('✅ پنل مدیریت Wifto روشن شد (@HmganBot)');
  pollLoop().catch((e) => log(`خطای حلقه polling: ${(e as Error).message}`));

  // اطلاع‌رسانی به مالک
  setTimeout(() => {
    sendMessage(
      OWNER_CHAT_ID,
      '🎛️ پنل مدیریت Wifto آنلاین شد! ✅\n\n📢 پیام همگانی | 🎯 ماموریت‌ها | 🎰 قرعه‌کشی | 📥 ارسالی‌ها | 📊 آمار\n\nهمه‌چیز از منوی پایین در دسترس است 👇',
      ADMIN_KB
    ).catch(() => {});
  }, 2000);
}
