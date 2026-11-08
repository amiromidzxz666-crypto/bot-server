// ============================================================
// لایه دیتابیس سیستم امتیاز Wifto (Prisma + SQLite)
// همه داده‌ها در db/custom.db ذخیره می‌شود و در بکاپ ۳۰ دقیقه‌ای
// گیت‌هاب (state/custom.db.enc) هم پشتیبان‌گیری می‌شود
// ============================================================
import { PrismaClient } from '@prisma/client';

const g = globalThis as unknown as { __wiftoPrisma?: PrismaClient };

export const p = g.__wiftoPrisma ?? new PrismaClient({ log: ['error'] });
g.__wiftoPrisma = p;

export type WiftoUser = {
  id: string;
  tgId: string;
  firstName?: string | null;
  username?: string | null;
  points: number;
  lotteries: number;
  wins: number;
  phone?: string | null;
  lastBonusAt?: Date | null; // آخرین امتیاز شانسی (کول‌داون ۱۲ ساعته)
};

/** ساخت/بروزرسانی کاربر با هر تعامل — هیچ‌وقت داده قبلی را پاک نمی‌کند */
export async function ensureUser(
  tgId: string,
  firstName?: string,
  username?: string
): Promise<WiftoUser> {
  return p.botUser.upsert({
    where: { tgId },
    create: { tgId, firstName: firstName ?? null, username: username ?? null },
    update: {
      ...(firstName ? { firstName } : {}),
      ...(username ? { username } : {}),
    },
  });
}

export async function getUserByTg(tgId: string): Promise<WiftoUser | null> {
  return p.botUser.findUnique({ where: { tgId } });
}

/** افزودن امتیاز (مثبت یا منفی) */
export async function addPoints(tgId: string, amount: number): Promise<void> {
  await p.botUser.update({
    where: { tgId },
    data: { points: { increment: amount } },
  });
}

/** برچسب نمایشی کاربر برای پیام‌های مدیر */
export function userLabel(u: {
  firstName?: string | null;
  username?: string | null;
  tgId: string;
}): string {
  const name = u.firstName?.trim() || 'کاربر';
  const un = u.username ? ` (@${u.username})` : '';
  return `${name}${un} — 🆔 ${u.tgId}`;
}

/** تاریخ و ساعت تهران */
export function faTime(d: Date | number | string): string {
  try {
    return new Date(d).toLocaleString('fa-IR', {
      timeZone: 'Asia/Tehran',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
  } catch {
    return new Date(d).toISOString();
  }
}

/** تبدیل ارقام فارسی/عربی به انگلیسی */
export function toEnDigits(s: string): string {
  const fa = '۰۱۲۳۴۵۶۷۸۹';
  const ar = '٠١٢٣٤٥٦٧٨٩';
  return s
    .replace(/[۰-۹]/g, (d) => String(fa.indexOf(d)))
    .replace(/[٠-٩]/g, (d) => String(ar.indexOf(d)));
}

/** جداکننده هزارگان برای اعداد */
export function fmtNum(n: number): string {
  return n.toLocaleString('en-US');
}
