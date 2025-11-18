import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { ensureProfile } from "@/lib/ensure-profile";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

function resolveErrorMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return fallback;
}

async function requireUser() {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error) {
    throw new Error(error.message);
  }

  if (!user) {
    return { supabase, user: null } as const;
  }

  await ensureProfile(user);
  return { supabase, user } as const;
}

export async function GET() {
  try {
    const { user } = await requireUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const profile = await prisma.user.findUnique({ where: { id: user.id } });

    return NextResponse.json({
      id: user.id,
      email: user.email,
      name: profile?.name ?? null,
      phone: profile?.phone ?? null,
    });
  } catch (error: unknown) {
    return NextResponse.json(
      { error: resolveErrorMessage(error, "Failed to load profile") },
      { status: 500 }
    );
  }
}

export async function PATCH(request: Request) {
  try {
    const { user } = await requireUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const payload = await request.json();

    const name = typeof payload.name === "string" ? payload.name.trim() : undefined;
    const phone = typeof payload.phone === "string" ? payload.phone.trim() : undefined;

    if (!name || name.length === 0) {
      return NextResponse.json(
        { error: "Name is required" },
        { status: 400 }
      );
    }

    const updated = await prisma.user.update({
      where: { id: user.id },
      data: {
        name,
        phone: phone && phone.length > 0 ? phone : null,
        email: user.email ?? "",
      },
    });

    return NextResponse.json({
      id: updated.id,
      email: updated.email,
      name: updated.name,
      phone: updated.phone,
    });
  } catch (error: unknown) {
    return NextResponse.json(
      { error: resolveErrorMessage(error, "Failed to update profile") },
      { status: 500 }
    );
  }
}
