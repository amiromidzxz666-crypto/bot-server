// ============================================================
// پل جایگزین ZAI — اول SDK اصلی (اگر کانفیگ موجود باشد)،
// اگر کند بود یا خطا داد به Pollinations (رایگان و بدون کلید) می‌رود،
// اما SDK اصلی هر ۵ دقیقه دوباره امتحان می‌شود (مرگ دائمی ندارد).
// هر فراخوانی سقف زمانی دارد تا یک درخواست هنگ‌کرده، صف پیام‌های چت را قفل نکند.
// ============================================================
import ZAIReal from 'z-ai-web-dev-sdk';

type ChatParams = { messages: unknown[]; thinking?: unknown; [k: string]: unknown };
type ChatResp = { choices?: Array<{ message?: { content?: string } }> };
type ImageParams = { prompt: string; size?: string };
type ImageResp = { data?: Array<{ base64?: string; url?: string }> };

const CREATE_TIMEOUT_MS = 30_000; // سقف ساخت کلاینت SDK
const REAL_TIMEOUT_MS = 60_000; // سقف هر پاسخ SDK اصلی
const POLL_TIMEOUT_MS = 45_000; // سقف Pollinations برای متن
const IMAGE_TIMEOUT_MS = 180_000; // سقف ساخت تصویر
const FAIL_THRESHOLD = 3; // سه شکست پشت‌سرهم → استراحت کوتاه
const COOLDOWN_MS = 5 * 60_000; // بعد از استراحت، SDK اصلی دوباره امتحان می‌شود

let realFails = 0;
let realCooldownUntil = 0;

const log = (m: string) => console.log(`[zai-shim] ${m}`);

function raceTimeout<T>(p: Promise<T>, ms: number, tag: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, rej) =>
      setTimeout(() => rej(new Error(`${tag} timeout (${Math.round(ms / 1000)}s)`)), ms),
    ),
  ]);
}

async function pollChat(params: ChatParams): Promise<ChatResp> {
  const res = await fetch('https://text.pollinations.ai/openai', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'openai', messages: params.messages }),
    signal: AbortSignal.timeout(POLL_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`pollinations chat ${res.status}`);
  return (await res.json()) as ChatResp;
}

async function pollImage(p: ImageParams): Promise<ImageResp> {
  const [w, h] = (p.size ?? '1024x1024').split('x');
  const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(
    p.prompt,
  )}?width=${w}&height=${h}&nologo=true`;
  const res = await fetch(url, { signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`pollinations image ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return { data: [{ base64: buf.toString('base64') }] };
}

function realDown() {
  realFails++;
  if (realFails >= FAIL_THRESHOLD) {
    realCooldownUntil = Date.now() + COOLDOWN_MS;
    realFails = 0;
    log(
      `SDK اصلی ${FAIL_THRESHOLD} بار خطا داد → ${COOLDOWN_MS / 1000} ثانیه Pollinations، بعد دوباره امتحان می‌شود`,
    );
  }
}

export default class ZAI {
  static async create() {
    let real: Awaited<ReturnType<typeof ZAIReal.create>> | null = null;
    try {
      real = await raceTimeout(ZAIReal.create(), CREATE_TIMEOUT_MS, 'create');
    } catch {
      log('کانفیگ SDK اصلی در دسترس نیست — فقط Pollinations');
      real = null;
    }

    const tryReal = async <T>(fn: () => Promise<T>, tag: string): Promise<T | null> => {
      if (!real || Date.now() < realCooldownUntil) return null;
      try {
        const out = await raceTimeout(fn(), REAL_TIMEOUT_MS, tag);
        realFails = 0;
        return out;
      } catch (e) {
        realDown();
        log(`${tag} خطا داد (${(e as Error).message})`);
        return null;
      }
    };

    return {
      chat: {
        completions: {
          create: async (params: ChatParams): Promise<ChatResp> => {
            const r = await tryReal(
              () => real!.chat.completions.create(params as never),
              'SDK اصلی',
            );
            if (r) return r as ChatResp;
            return pollChat(params);
          },
        },
      },
      images: {
        generations: {
          create: async (params: ImageParams): Promise<ImageResp> => {
            const r = await tryReal(
              () => real!.images.generations.create(params as never),
              'SDK اصلی (عکس)',
            );
            if (r) return r as ImageResp;
            return pollImage(params);
          },
        },
      },
    };
  }
}
