import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function POST() {
  return NextResponse.json(
    { error: "This endpoint has been replaced by Supabase Auth." },
    { status: 410 }
  );
}
