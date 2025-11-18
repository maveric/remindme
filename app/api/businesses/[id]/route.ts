import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { ensureProfile } from "@/lib/ensure-profile";
import { Prisma } from "@prisma/client";

export const runtime = "nodejs";

type Params = {
  params: {
    id: string;
  };
};

function resolveErrorMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return fallback;
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

export async function PATCH(req: Request, { params }: Params) {
  const businessId = Number(params.id);

  if (!businessId || Number.isNaN(businessId)) {
    return NextResponse.json(
      { error: "A valid business id is required" },
      { status: 400 }
    );
  }

  try {
    const supabase = createSupabaseServerClient();
    const {
      data: { user },
      error,
    } = await supabase.auth.getUser();

    if (error) {
      throw new Error(error.message);
    }

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    await ensureProfile(user);

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

    const existing = await prisma.business.findFirst({
      where: { id: businessId, userId: user.id },
    });

    if (!existing) {
      return NextResponse.json({ error: "Company not found" }, { status: 404 });
    }

    const [businessType, jurisdiction] = await Promise.all([
      businessTypeName ? findOrCreateBusinessType(businessTypeName) : Promise.resolve(null),
      jurisdictionName ? findOrCreateJurisdiction(jurisdictionName) : Promise.resolve(null),
    ]);

    const updateData: Prisma.BusinessUncheckedUpdateInput = {
      name,
      phone: phone.length > 0 ? phone : null,
      notes: notes.length > 0 ? notes : null,
      businessTypeId: businessTypeName
        ? businessType?.id ?? existing.businessTypeId
        : null,
      jurisdictionId: jurisdictionName
        ? jurisdiction?.id ?? existing.jurisdictionId
        : null,
    };

    const updated = await prisma.business.update({
      where: { id: businessId },
      data: updateData,
      include: { businessType: true, jurisdiction: true },
    });

    return NextResponse.json(mapBusiness(updated));
  } catch (error: unknown) {
    return NextResponse.json(
      { error: resolveErrorMessage(error, "Failed to update company") },
      { status: 500 }
    );
  }
}

export async function DELETE(req: Request, { params }: Params) {
  const businessId = Number(params.id);

  if (!businessId || Number.isNaN(businessId)) {
    return NextResponse.json(
      { error: "A valid business id is required" },
      { status: 400 }
    );
  }
  try {
    const supabase = createSupabaseServerClient();
    const {
      data: { user },
      error,
    } = await supabase.auth.getUser();

    if (error) {
      throw new Error(error.message);
    }

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    await ensureProfile(user);

    const existing = await prisma.business.findFirst({
      where: { id: businessId, userId: user.id },
    });

    if (!existing) {
      return NextResponse.json({ error: "Company not found" }, { status: 404 });
    }

    await prisma.business.delete({ where: { id: businessId } });

    return NextResponse.json({ success: true });
  } catch (error: unknown) {
    return NextResponse.json(
      { error: resolveErrorMessage(error, "Failed to delete company") },
      { status: 500 }
    );
  }
}
