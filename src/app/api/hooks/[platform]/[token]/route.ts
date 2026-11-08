import { NextRequest, NextResponse } from "next/server";
import { TOKEN as TG_TOKEN, handleWebhookUpdate as handleTelegram } from "@/lib/telegram-bot";
import { TOKEN as SP_TOKEN, handleWebhookUpdate as handleSoroush } from "@/lib/soroush-bot";

export const dynamic = "force-dynamic";

// ============================================================
// دریافت‌کننده وب‌هوک ربات‌ها (تلگرام + سروش پلاس)
// مسیر: /api/hooks/{platform}/{token}
// توکن داخل مسیر همان اعتبارسنجی است — مثل خود API تلگرام
// پاسخ «ok» بلافاصله برمی‌گردد و پردازش در صف per-chat پس‌زمینه ادامه می‌یابد
// ============================================================

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ platform: string; token: string }> }
) {
  const { platform, token } = await ctx.params;

  let handler: ((u: unknown) => void) | null = null;
  if (platform === "telegram" && token === TG_TOKEN) {
    handler = handleTelegram as (u: unknown) => void;
  } else if (platform === "soroush" && token === SP_TOKEN) {
    handler = handleSoroush as (u: unknown) => void;
  }
  if (!handler) return NextResponse.json({ ok: false }, { status: 403 });

  const update = await req.json().catch(() => null);
  if (!update || typeof update !== "object") {
    return NextResponse.json({ ok: false }, { status: 400 });
  }

  try {
    handler(update); // پردازش async داخل صف per-chat
  } catch {
    /* هیچ‌وقت خطا به بیرون نشت نکند */
  }
  return NextResponse.json({ ok: true });
}

export async function GET() {
  return NextResponse.json({ ok: true, service: "bots-webhook", ts: Date.now() });
}
