import { NextRequest, NextResponse } from 'next/server';

// ============================================================
// لاگر موقت برای کشف URL عمومی سندباکس:
// درخواست‌های دوره‌ای مانیتور پلتفرم به / هدر Host را لو می‌دهند
// (بعد از ثبت آدرس در db/webhook-base-url.txt می‌توان حذفش کرد)
// ============================================================
export function middleware(req: NextRequest) {
  const h = req.headers;
  console.log(
    `[HOST-LOG] ${req.method} ${req.nextUrl.pathname} host=${h.get('host') ?? '?'} ` +
      `xfh=${h.get('x-forwarded-host') ?? '-'} xfh-proto=${h.get('x-forwarded-proto') ?? '-'} ` +
      `referer=${(h.get('referer') ?? '-').slice(0, 120)} ua="${(h.get('user-agent') ?? '?').slice(0, 80)}"`
  );
  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
