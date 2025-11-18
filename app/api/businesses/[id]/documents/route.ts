import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { ensureProfile } from "@/lib/ensure-profile";
import { PERMIT_FILES_BUCKET, PermitSourceFileMeta } from "@/lib/storage";
import {
  BusinessDocument,
  DocumentCategory,
  DocumentStatus,
  IssuingAuthority,
  Jurisdiction,
  Prisma,
} from "@prisma/client";

export const runtime = "nodejs";

type RouteParams = {
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

function parseId(source: string): number | null {
  const value = Number(source);
  if (!Number.isFinite(value) || value <= 0) {
    return null;
  }
  return value;
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

async function requireBusiness(userId: string, businessId: number) {
  return prisma.business.findFirst({
    where: {
      id: businessId,
      userId,
    },
  });
}

type DocumentWithRelations = BusinessDocument & {
  jurisdiction: Jurisdiction | null;
  issuingAuthority: IssuingAuthority | null;
};

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

export async function GET(_req: Request, { params }: RouteParams) {
  const businessId = parseId(params.id);

  if (!businessId) {
    return NextResponse.json({ error: "A valid company id is required" }, { status: 400 });
  }

  try {
    const user = await resolveUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const business = await requireBusiness(user.id, businessId);

    if (!business) {
      return NextResponse.json({ error: "Company not found" }, { status: 404 });
    }

    const documents = await prisma.businessDocument.findMany({
      where: { businessId: business.id },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      include: {
        jurisdiction: true,
        issuingAuthority: true,
      },
    });

    return NextResponse.json(documents.map(mapDocument));
  } catch (error: unknown) {
    return NextResponse.json(
      { error: resolveErrorMessage(error, "Failed to load permits") },
      { status: 500 }
    );
  }
}

export async function POST(req: Request, { params }: RouteParams) {
  const businessId = parseId(params.id);

  if (!businessId) {
    return NextResponse.json({ error: "A valid company id is required" }, { status: 400 });
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

  const jurisdictionName =
    typeof payload.jurisdictionName === "string" ? payload.jurisdictionName.trim() : "";
  const issuingAuthorityName =
    typeof payload.issuingAuthorityName === "string" ? payload.issuingAuthorityName.trim() : "";

  try {
    const user = await resolveUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const business = await requireBusiness(user.id, businessId);

    if (!business) {
      return NextResponse.json({ error: "Company not found" }, { status: 404 });
    }

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

    const document = await prisma.businessDocument.create({
      data: {
        businessId: business.id,
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
        rawExtractionJson: rawExtraction ?? Prisma.JsonNull,
        jurisdictionId: jurisdiction?.id ?? null,
        issuingAuthorityId: issuingAuthority?.id ?? null,
        sourceFileBucket: sourceFileDecision.action === "set" ? sourceFileDecision.value.bucket : null,
        sourceFilePath: sourceFileDecision.action === "set" ? sourceFileDecision.value.path : null,
        sourceFileContentType:
          sourceFileDecision.action === "set" ? sourceFileDecision.value.contentType : null,
        sourceFileName:
          sourceFileDecision.action === "set" ? sourceFileDecision.value.name : null,
        sourceFileSize: sourceFileDecision.action === "set" ? sourceFileDecision.value.size : null,
      },
      include: {
        jurisdiction: true,
        issuingAuthority: true,
      },
    });

    return NextResponse.json(mapDocument(document), { status: 201 });
  } catch (error: unknown) {
    if (error instanceof SourceFilePayloadError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    return NextResponse.json(
      { error: resolveErrorMessage(error, "Failed to add permit") },
      { status: 500 }
    );
  }
}
