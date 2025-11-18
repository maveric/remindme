import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { ensureProfile } from "@/lib/ensure-profile";
import { DocumentCategory, DocumentStatus, Prisma } from "@prisma/client";
import { PERMIT_FILES_BUCKET, PermitSourceFileMeta } from "@/lib/storage";

export const runtime = "nodejs";

type RouteParams = {
  params: {
    id: string;
    documentId: string;
  };
};

function resolveErrorMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return fallback;
}

function parseId(value: string): number | null {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return null;
  }
  return numeric;
}

function normalizeCategory(value?: unknown): DocumentCategory {
  if (typeof value === "string") {
    const normalized = value.trim().toUpperCase();
    if (Object.values(DocumentCategory).includes(normalized as DocumentCategory)) {
      return normalized as DocumentCategory;
    }
  }
  return DocumentCategory.PERMIT;
}

function normalizeStatus(value?: unknown): DocumentStatus {
  if (typeof value === "string") {
    const normalized = value.trim().toUpperCase().replace(/[\s-]+/g, "_");
    if (Object.values(DocumentStatus).includes(normalized as DocumentStatus)) {
      return normalized as DocumentStatus;
    }
  }
  return DocumentStatus.ACTIVE;
}

function parseDate(value?: unknown): Date | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed;
}

async function resolveUser() {
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

type DocumentWithRelations = Prisma.BusinessDocumentGetPayload<{
  include: { jurisdiction: true; issuingAuthority: true };
}>;

function mapDocument(document: DocumentWithRelations) {
  return {
    id: document.id,
    businessId: document.businessId,
    title: document.title,
    permitNumber: document.permitNumber,
    documentCategory: document.documentCategory,
    status: document.status,
    startDate: document.startDate ? document.startDate.toISOString() : null,
    endDate: document.endDate ? document.endDate.toISOString() : null,
    autoRenew: document.autoRenew,
    createdAt: document.createdAt.toISOString(),
    updatedAt: document.updatedAt.toISOString(),
    issuingAuthorityName: document.issuingAuthority?.name ?? null,
    jurisdictionName: document.jurisdiction?.name ?? null,
    rawExtractionJson: document.rawExtractionJson ?? null,
    sourceFileBucket: document.sourceFileBucket,
    sourceFilePath: document.sourceFilePath,
    sourceFileContentType: document.sourceFileContentType,
    sourceFileName: document.sourceFileName,
    sourceFileSize: document.sourceFileSize,
  };
}

type SourceFileDecision =
  | { action: "ignore" }
  | { action: "clear" }
  | { action: "set"; value: PermitSourceFileMeta };

class SourceFilePayloadError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

function resolveSourceFileDecision(payload: Record<string, unknown>, userId: string): SourceFileDecision {
  const keys = [
    payload.sourceFileBucket,
    payload.sourceFilePath,
    payload.sourceFileContentType,
    payload.sourceFileName,
    payload.sourceFileSize,
  ];

  const provided = keys.some((value) => value !== undefined);
  if (!provided) {
    return { action: "ignore" };
  }

  const bucket = payload.sourceFileBucket;
  const path = payload.sourceFilePath;

  if (bucket === null || bucket === "" || path === null || path === "") {
    return { action: "clear" };
  }

  if (typeof bucket !== "string" || typeof path !== "string") {
    throw new SourceFilePayloadError("Invalid source file metadata");
  }

  if (bucket !== PERMIT_FILES_BUCKET || !path.startsWith(`${userId}/`)) {
    throw new SourceFilePayloadError("Invalid source file reference");
  }

  const contentType =
    typeof payload.sourceFileContentType === "string" && payload.sourceFileContentType.trim().length > 0
      ? payload.sourceFileContentType.trim()
      : "application/octet-stream";
  const name =
    typeof payload.sourceFileName === "string" && payload.sourceFileName.trim().length > 0
      ? payload.sourceFileName.trim()
      : "permit-file";

  const sizeValue = payload.sourceFileSize;
  const numericSize =
    typeof sizeValue === "number"
      ? sizeValue
      : typeof sizeValue === "string" && sizeValue.trim().length > 0
      ? Number.parseInt(sizeValue, 10)
      : Number.NaN;

  if (!Number.isFinite(numericSize)) {
    throw new SourceFilePayloadError("Invalid source file size");
  }

  return {
    action: "set",
    value: {
      bucket,
      path,
      contentType,
      name,
      size: numericSize,
    },
  };
}

async function findOrCreateJurisdiction(name: string) {
  const existing = await prisma.jurisdiction.findFirst({ where: { name } });
  if (existing) {
    return existing;
  }
  return prisma.jurisdiction.create({ data: { name } });
}

async function findOrCreateIssuingAuthority(name: string) {
  const existing = await prisma.issuingAuthority.findFirst({ where: { name } });
  if (existing) {
    return existing;
  }
  return prisma.issuingAuthority.create({ data: { name } });
}

export async function PATCH(req: Request, { params }: RouteParams) {
  const businessId = parseId(params.id);
  const documentId = parseId(params.documentId);

  if (!businessId || !documentId) {
    return NextResponse.json({ error: "Valid ids are required" }, { status: 400 });
  }

  let payload: Record<string, unknown>;

  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload" }, { status: 400 });
  }

  const title = typeof payload.title === "string" ? payload.title.trim() : "";
  if (!title) {
    return NextResponse.json({ error: "Permit title is required" }, { status: 400 });
  }

  try {
    const user = await resolveUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const existingBusiness = await prisma.business.findFirst({
      where: {
        id: businessId,
        userId: user.id,
      },
    });

    if (!existingBusiness) {
      return NextResponse.json({ error: "Company not found" }, { status: 404 });
    }

    const existingDocument = await prisma.businessDocument.findFirst({
      where: {
        id: documentId,
        businessId: existingBusiness.id,
      },
    });

    if (!existingDocument) {
      return NextResponse.json({ error: "Permit not found" }, { status: 404 });
    }

    const jurisdictionName =
      typeof payload.jurisdictionName === "string" ? payload.jurisdictionName.trim() : "";
    const issuingAuthorityName =
      typeof payload.issuingAuthorityName === "string" ? payload.issuingAuthorityName.trim() : "";

    const startDate = parseDate(payload.startDate);
    const endDate = parseDate(payload.endDate);
    const sourceFileDecision = resolveSourceFileDecision(payload, user.id);
    const rawExtraction: Prisma.InputJsonValue | undefined =
      payload.rawExtraction === undefined
        ? undefined
        : (payload.rawExtraction as Prisma.InputJsonValue);

    const [jurisdiction, issuingAuthority] = await Promise.all([
      jurisdictionName ? findOrCreateJurisdiction(jurisdictionName) : Promise.resolve(null),
      issuingAuthorityName ? findOrCreateIssuingAuthority(issuingAuthorityName) : Promise.resolve(null),
    ]);

    const updateData: Prisma.BusinessDocumentUncheckedUpdateInput = {
      title,
      permitNumber:
        typeof payload.permitNumber === "string" && payload.permitNumber.trim().length > 0
          ? payload.permitNumber.trim()
          : null,
      documentCategory: normalizeCategory(payload.documentCategory),
      status: normalizeStatus(payload.status),
      startDate,
      endDate,
      autoRenew: payload.autoRenew === true,
    };

    if (rawExtraction !== undefined) {
      updateData.rawExtractionJson = rawExtraction ?? Prisma.JsonNull;
    }

    if (jurisdictionName === "") {
      updateData.jurisdictionId = null;
    } else if (jurisdiction) {
      updateData.jurisdictionId = jurisdiction.id;
    }

    if (issuingAuthorityName === "") {
      updateData.issuingAuthorityId = null;
    } else if (issuingAuthority) {
      updateData.issuingAuthorityId = issuingAuthority.id;
    }

    if (sourceFileDecision.action === "set") {
      updateData.sourceFileBucket = sourceFileDecision.value.bucket;
      updateData.sourceFilePath = sourceFileDecision.value.path;
      updateData.sourceFileContentType = sourceFileDecision.value.contentType;
      updateData.sourceFileName = sourceFileDecision.value.name;
      updateData.sourceFileSize = sourceFileDecision.value.size;
    } else if (sourceFileDecision.action === "clear") {
      updateData.sourceFileBucket = null;
      updateData.sourceFilePath = null;
      updateData.sourceFileContentType = null;
      updateData.sourceFileName = null;
      updateData.sourceFileSize = null;
    }

    const updated = await prisma.businessDocument.update({
      where: { id: existingDocument.id },
      data: updateData,
      include: {
        jurisdiction: true,
        issuingAuthority: true,
      },
    });

    return NextResponse.json(mapDocument(updated));
  } catch (error: unknown) {
    if (error instanceof SourceFilePayloadError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json(
      { error: resolveErrorMessage(error, "Failed to update permit") },
      { status: 500 }
    );
  }
}
