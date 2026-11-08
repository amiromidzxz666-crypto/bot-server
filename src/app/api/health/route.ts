import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// endpoint سبک برای keep-alive داخلی و تست زنده بودن سرور
export async function GET() {
  return NextResponse.json({ ok: true, ts: Date.now() });
}
