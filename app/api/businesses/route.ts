import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { ensureProfile } from "@/lib/ensure-profile";
import { Prisma } from "@prisma/client";

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
    return null;
  }

  await ensureProfile(user);
  return user;
}

type BusinessWithRelations = Prisma.BusinessGetPayload<{
  include: { businessType: true; jurisdiction: true };
}>;

function mapBusiness(business: BusinessWithRelations) {
  return {
    id: business.id,
    userId: business.userId,
    name: business.name,
    phone: business.phone,
    notes: business.notes,
    businessTypeName: business.businessType?.name ?? null,
    jurisdictionName: business.jurisdiction?.name ?? null,
    createdAt: business.createdAt.toISOString(),
    updatedAt: business.updatedAt.toISOString(),
  };
}

async function findOrCreateBusinessType(name: string) {
  const existing = await prisma.businessType.findFirst({ where: { name } });
  if (existing) {
    return existing;
  }
  return prisma.businessType.create({ data: { name } });
}

async function findOrCreateJurisdiction(name: string) {
  const existing = await prisma.jurisdiction.findFirst({ where: { name } });
  if (existing) {
    return existing;
  }
  return prisma.jurisdiction.create({ data: { name } });
}

export async function GET() {
  try {
    const user = await requireUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const businesses = await prisma.business.findMany({
      where: { userId: user.id },
      orderBy: [{ name: "asc" }, { createdAt: "asc" }],
      include: { businessType: true, jurisdiction: true },
    });

    return NextResponse.json(businesses.map(mapBusiness));
  } catch (error: unknown) {
    return NextResponse.json(
      { error: resolveErrorMessage(error, "Failed to load companies") },
      { status: 500 }
    );
  }
}

export async function POST(req: Request) {
  try {
    const user = await requireUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const payload = await req.json();

    const name = typeof payload.name === "string" ? payload.name.trim() : "";
    const phone = typeof payload.phone === "string" ? payload.phone.trim() : "";
    const notes = typeof payload.notes === "string" ? payload.notes.trim() : "";
    const businessTypeName =
      typeof payload.businessTypeName === "string" ? payload.businessTypeName.trim() : "";
    const jurisdictionName =
      typeof payload.jurisdictionName === "string" ? payload.jurisdictionName.trim() : "";

    if (!name) {
      return NextResponse.json(
        { error: "Company name is required" },
        { status: 400 }
      );
    }

    const [businessType, jurisdiction] = await Promise.all([
      businessTypeName ? findOrCreateBusinessType(businessTypeName) : Promise.resolve(null),
      jurisdictionName ? findOrCreateJurisdiction(jurisdictionName) : Promise.resolve(null),
    ]);

    const business = await prisma.business.create({
      data: {
        userId: user.id,
        name,
        phone: phone.length > 0 ? phone : null,
        notes: notes.length > 0 ? notes : null,
        businessTypeId: businessType?.id ?? null,
        jurisdictionId: jurisdiction?.id ?? null,
      },
      include: { businessType: true, jurisdiction: true },
    });

    return NextResponse.json(mapBusiness(business), { status: 201 });
  } catch (error: unknown) {
    return NextResponse.json(
      { error: resolveErrorMessage(error, "Failed to add company") },
      { status: 500 }
    );
  }
}
