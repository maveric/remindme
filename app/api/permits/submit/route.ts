import { NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { prisma } from "@/lib/prisma";
import { DocumentCategory, DocumentStatus, Prisma, User } from "@prisma/client";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { ensureProfile } from "@/lib/ensure-profile";
import { PERMIT_FILES_BUCKET, PermitSourceFileMeta } from "@/lib/storage";

export const runtime = "nodejs";

type SubmitPayload = {
  userEmail?: string;
  businessName?: string;
  businessTypeName?: string;
  jurisdictionName?: string;
  issuingAuthorityName?: string;
  title?: string;
  permitTypeName?: string;
  permitNumber?: string;
  documentCategory?: string;
  status?: string;
  startDate?: string;
  endDate?: string;
  autoRenew?: boolean;
  rawExtraction?: unknown;
  sourceFileBucket?: string | null;
  sourceFilePath?: string | null;
  sourceFileContentType?: string | null;
  sourceFileName?: string | null;
  sourceFileSize?: number | string | null;
};

const DOCUMENT_CATEGORY_VALUES = new Set<string>(
  Object.values(DocumentCategory)
);
const DOCUMENT_STATUS_VALUES = new Set<string>(Object.values(DocumentStatus));

function deriveNameFromEmail(email: string): string {
  const [localPart = ""] = email.split("@");
  const trimmed = localPart.trim();

  if (!trimmed) {
    return "Permit Buddy User";
  }

  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

function normalizeCategory(value?: string): DocumentCategory {
  const normalized = value?.trim().toUpperCase();
  if (normalized && DOCUMENT_CATEGORY_VALUES.has(normalized)) {
    return normalized as DocumentCategory;
  }
  return DocumentCategory.PERMIT;
}

function normalizeStatus(value?: string): DocumentStatus {
  const normalized = value?.trim().toUpperCase().replace(/[\s-]+/g, "_");
  if (normalized && DOCUMENT_STATUS_VALUES.has(normalized)) {
    return normalized as DocumentStatus;
  }
  return DocumentStatus.ACTIVE;
}

function parseInputDate(value?: string | null): Date | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed;
}

export async function POST(req: Request) {
  let payload: SubmitPayload;

  try {
    payload = await req.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON payload" },
      { status: 400 }
    );
  }

  const businessName = payload.businessName?.trim();
  if (!businessName) {
    return NextResponse.json(
      { error: "Business name is required" },
      { status: 400 }
    );
  }

  const documentTitle = payload.title?.trim() || "Untitled document";
  const documentCategory = normalizeCategory(payload.documentCategory);
  const documentStatus = normalizeStatus(payload.status);
  const autoRenew = payload.autoRenew === true;
  const rawExtraction: Prisma.InputJsonValue | undefined =
    payload.rawExtraction === undefined
      ? undefined
      : (payload.rawExtraction as Prisma.InputJsonValue);

  try {
    const supabase = createSupabaseServerClient();
    const {
      data: { user: supabaseUser },
      error: supabaseError,
    } = await supabase.auth.getUser();

    if (supabaseError) {
      throw new Error(supabaseError.message);
    }

    let resolvedUser: User | null = null;

    if (supabaseUser) {
      resolvedUser = await ensureProfile(supabaseUser);
    } else {
      const userEmail = payload.userEmail?.trim().toLowerCase();

      if (!userEmail) {
        return NextResponse.json(
          { error: "Unauthorized" },
          { status: 401 }
        );
      }

      resolvedUser =
        (await prisma.user.findUnique({ where: { email: userEmail } })) ??
        (await prisma.user.create({
          data: {
            id: randomUUID(),
            email: userEmail,
            name: deriveNameFromEmail(userEmail),
          },
        }));
    }

    if (!resolvedUser) {
      return NextResponse.json(
        { error: "Unauthorized" },
        { status: 401 }
      );
    }

    return await handleSave(
      payload,
      businessName,
      documentTitle,
      documentCategory,
      documentStatus,
      autoRenew,
      rawExtraction,
      resolvedUser.id
    );
  } catch (error) {
    if (error instanceof SourceFilePayloadError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.error("Failed to save document", error);
    return NextResponse.json(
      { error: "Failed to save document" },
      { status: 500 }
    );
  }
}

async function handleSave(
  payload: SubmitPayload,
  businessName: string,
  documentTitle: string,
  documentCategory: DocumentCategory,
  documentStatus: DocumentStatus,
  autoRenew: boolean,
  rawExtraction: Prisma.InputJsonValue | undefined,
  userId: string
) {
  const businessTypeName = payload.businessTypeName?.trim();
  const jurisdictionName = payload.jurisdictionName?.trim();
  const permitTypeName = payload.permitTypeName?.trim();
  const issuingAuthorityName = payload.issuingAuthorityName?.trim();
  const sourceFileMeta = resolveSourceFileMetadata(payload, userId);

  const [businessType, jurisdiction, permitType, issuingAuthority] =
    await Promise.all([
      businessTypeName
        ? findOrCreateBusinessType(businessTypeName)
        : Promise.resolve(null),
      jurisdictionName
        ? findOrCreateJurisdiction(jurisdictionName)
        : Promise.resolve(null),
      permitTypeName
        ? findOrCreatePermitType(permitTypeName)
        : Promise.resolve(null),
      issuingAuthorityName
        ? findOrCreateIssuingAuthority(issuingAuthorityName)
        : Promise.resolve(null),
    ]);

  let business = await prisma.business.findFirst({
    where: {
      name: businessName,
      userId,
    },
  });

  if (!business) {
    business = await prisma.business.create({
      data: {
        name: businessName,
        userId,
        businessTypeId: businessType?.id || null,
        jurisdictionId: jurisdiction?.id || null,
      },
    });
  } else {
    const updates: Record<string, number> = {};
    if (!business.businessTypeId && businessType?.id) {
      updates.businessTypeId = businessType.id;
    }
    if (!business.jurisdictionId && jurisdiction?.id) {
      updates.jurisdictionId = jurisdiction.id;
    }

    if (Object.keys(updates).length > 0) {
      business = await prisma.business.update({
        where: { id: business.id },
        data: updates,
      });
    }
  }

  const startDate = parseInputDate(payload.startDate);
  const endDate = parseInputDate(payload.endDate);

  const document = await prisma.businessDocument.create({
    data: {
      businessId: business.id,
      documentCategory,
      permitTypeId: permitType?.id ?? null,
      issuingAuthorityId: issuingAuthority?.id ?? null,
      jurisdictionId: jurisdiction?.id ?? null,
      title: documentTitle,
      permitNumber: payload.permitNumber?.trim() || null,
      startDate: startDate ?? null,
      endDate: endDate ?? null,
      autoRenew,
      status: documentStatus,
      rawExtractionJson: rawExtraction ?? Prisma.JsonNull,
      sourceFileBucket: sourceFileMeta?.bucket ?? null,
      sourceFilePath: sourceFileMeta?.path ?? null,
      sourceFileContentType: sourceFileMeta?.contentType ?? null,
      sourceFileName: sourceFileMeta?.name ?? null,
      sourceFileSize: sourceFileMeta?.size ?? null,
    },
    include: {
      business: true,
      permitType: true,
      jurisdiction: true,
      issuingAuthority: true,
    },
  });

  return NextResponse.json({ document }, { status: 201 });
}

async function findOrCreateBusinessType(name: string) {
  const existing = await prisma.businessType.findFirst({ where: { name } });
  if (existing) return existing;
  return prisma.businessType.create({ data: { name } });
}

async function findOrCreateJurisdiction(name: string) {
  const existing = await prisma.jurisdiction.findFirst({ where: { name } });
  if (existing) return existing;
  return prisma.jurisdiction.create({ data: { name } });
}

async function findOrCreatePermitType(name: string) {
  const existing = await prisma.permitType.findFirst({ where: { name } });
  if (existing) return existing;
  return prisma.permitType.create({ data: { name } });
}

async function findOrCreateIssuingAuthority(name: string) {
  const existing = await prisma.issuingAuthority.findFirst({ where: { name } });
  if (existing) return existing;
  return prisma.issuingAuthority.create({ data: { name } });
}

class SourceFilePayloadError extends Error {}

function resolveSourceFileMetadata(
  payload: SubmitPayload,
  userId: string
): PermitSourceFileMeta | null {
  const bucket = payload.sourceFileBucket?.trim();
  const path = payload.sourceFilePath?.trim();

  if (!bucket || !path) {
    return null;
  }

  if (bucket !== PERMIT_FILES_BUCKET || !path.startsWith(`${userId}/`)) {
    throw new SourceFilePayloadError("Invalid source file reference");
  }

  const contentType =
    payload.sourceFileContentType && payload.sourceFileContentType.trim().length > 0
      ? payload.sourceFileContentType.trim()
      : "application/octet-stream";
  const name =
    payload.sourceFileName && payload.sourceFileName.trim().length > 0
      ? payload.sourceFileName.trim()
      : "Permit file";

  const sizeValue = payload.sourceFileSize;
  const numericSize =
    typeof sizeValue === "number"
      ? sizeValue
      : typeof sizeValue === "string" && sizeValue.trim().length > 0
      ? Number.parseInt(sizeValue, 10)
      : 0;

  if (!Number.isFinite(numericSize) || numericSize < 0) {
    throw new SourceFilePayloadError("Invalid source file size");
  }

  return {
    bucket,
    path,
    contentType,
    name,
    size: numericSize,
  };
}
