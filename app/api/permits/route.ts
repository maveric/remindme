import { NextResponse } from "next/server";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { DocumentCategory, DocumentStatus } from "@prisma/client";
import { randomUUID } from "crypto";
import { openai } from "@/lib/openai";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceClient } from "@/lib/supabase/service";
import { PERMIT_FILES_BUCKET, PermitSourceFileMeta } from "@/lib/storage";

export const runtime = "nodejs"; // ensure we have Node APIs like Buffer

function resolveErrorMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return fallback;
}

const DOCUMENT_CATEGORIES = Object.values(DocumentCategory);
const DOCUMENT_STATUSES = Object.values(DocumentStatus);

function normalizeCategory(value?: unknown): DocumentCategory {
  if (typeof value === "string") {
    const normalized = value.trim().toUpperCase();
    if (DOCUMENT_CATEGORIES.includes(normalized as DocumentCategory)) {
      return normalized as DocumentCategory;
    }
  }
  return DocumentCategory.PERMIT;
}

function normalizeStatus(value?: unknown): DocumentStatus {
  if (typeof value === "string") {
    const normalized = value.trim().toUpperCase().replace(/[\s-]+/g, "_");
    if (DOCUMENT_STATUSES.includes(normalized as DocumentStatus)) {
      return normalized as DocumentStatus;
    }
  }
  return DocumentStatus.ACTIVE;
}

function normalizeDate(value?: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    return "";
  }
  return parsed.toISOString().slice(0, 10);
}

function normalizeBoolean(value?: unknown): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true" || normalized === "yes") {
      return true;
    }
    if (normalized === "false" || normalized === "no") {
      return false;
    }
  }
  return false;
}

function sanitizeAscii(input: string): string {
  return input.replace(/[^\x20-\x7E]+/g, "");
}

export async function POST(req: Request) {
  const formData = await req.formData();
  const file = formData.get("file") as File | null;

  if (!file) {
    return NextResponse.json({ error: "No file uploaded" }, { status: 400 });
  }

  const supabase = createSupabaseServerClient();
  const supabaseService = createSupabaseServiceClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Read file contents
  const bytes = await file.arrayBuffer();
  const fileBuffer = Buffer.from(bytes);
  const base64 = fileBuffer.toString("base64");
  const dataUrl = `data:${file.type};base64,${base64}`;
  const currentDate = new Date().toISOString().slice(0, 10);

  let sourceFileMeta: PermitSourceFileMeta;
  try {
    sourceFileMeta = await resolveOrUploadSourceFile(formData, {
      supabaseStorage: supabaseService,
      userId: user.id,
      file,
      fileBuffer,
    });
  } catch (error) {
    const sourceError = error instanceof SourceFileError ? error : null;
    console.error("Source file handling failed", error);
    return NextResponse.json(
      { error: sourceError?.message ?? "Failed to handle source document" },
      { status: sourceError?.status ?? 500 }
    );
  }

  // 🔍 Ask the model to extract structured data as JSON
  // NOTE: The exact shape for image+text messages may differ slightly by model version.
  // Check OpenAI docs for the latest message format if something errors.
  const messages: ChatCompletionMessageParam[] = [
    {
      role: "system",
      content:
        "You are an expert compliance assistant who extracts structured permit data from uploaded documents. Always respond with ONLY a valid JSON object that matches the requested schema.",
    },
    {
      role: "user",
      content: [
        {
          type: "text",
          text: `You are helping populate a permit management form. Analyze this document (PDF or image) and infer as much detail as possible.

Today's date is ${currentDate}. Use it as the reference when determining whether a permit is PENDING_ACTIVATION, ACTIVE, PENDING_RENEWAL, or EXPIRED.

Return JSON with the following keys:
- title: concise permit or license title. Prefer the document headline or a combination of permit type and location. If a vehicle, include vehicle year, and type. Use an empty string if unknown.
- permit_number: the permit or license identifier. Empty string if unknown.
- document_category: choose ONE of [PERMIT, LICENSE, INSPECTION, INSURANCE, REGISTRATION, CERTIFICATION, AGREEMENT, OTHER]. Select the closest match.
- status: choose ONE of [PENDING_ACTIVATION, ACTIVE, EXPIRED, PENDING_RENEWAL, INACTIVE]. Infer from context (e.g., expired date -> EXPIRED, upcoming renewal -> PENDING_RENEWAL) or default to ACTIVE if unclear.
- start_date: the issuance or effective date in ISO format YYYY-MM-DD, or an empty string if unclear.
- end_date: the expiration or renewal date in ISO format YYYY-MM-DD, or an empty string if unclear.
- auto_renew: boolean true/false. Use true only if the document explicitly states automatic renewal, otherwise false.
- jurisdiction: the municipality, county, state, or other jurisdiction tied to this permit. Empty string if unknown.
- issuing_authority: the department, agency, or organization that issued the permit. Empty string if unknown.

Rules:
- Use only ASCII characters in the JSON.
- Never invent data, but infer when the document makes it obvious.
- If multiple dates exist, treat the earliest issuance/duty date as start_date and the latest validity/expiration as end_date.
- Ensure that start_date is always on or before end_date.
- For end_date: If a specific expiration date is not present, *calculate* it from the start_date and the extracted term_duration. (e.g., start_date "2025-01-01" and term_duration "one year" -> end_date "2025-12-31").
- For status: You MUST determine the status by following these rules in this specific order:
  1.  If the start_date is after ${currentDate}, the status is PENDING_ACTIVATION.
  2.  ELSE, if the end_date is before ${currentDate}, the status is EXPIRED.
  3.  ELSE, if the start_date is on or before ${currentDate} AND the end_date is on or after ${currentDate}, the status is ACTIVE.
  4.  ELSE (e.g., if no dates are found), default to ACTIVE.
- For document_category: Prioritize the document's main title (e.g., a "Certificate of Liability Insurance" is INSURANCE).
- Examples:
  - Input Text Snippet: "Certificate of Liability. This policy is effective January 1, 2025. This certificate is not valid for more than one year from the effective date."
  - Output JSON:
    {
      "title": "Certificate of Liability",
      "permit_number": "",
      "document_category": "INSURANCE",
      "status": "ACTIVE",
      "start_date": "2025-01-01",
      "end_date": "2025-12-31",
      "term_duration": "one year",
      "auto_renew": false,
      "jurisdiction": "",
      "issuing_authority": ""
    }
  - Input Text Snippet: "Current date - 2025-11-17, PENNSYLVANIA FINANCIAL RESPONSIBILITY IDENTIFICATION CARD. Effective Date 01/12/26. NOT VALID MORE THAN SIX MONTHS FROM EFFECTIVE DATE. Vehicle: 2015 FORD."
  - Output JSON:
    {
      "title": "2015 FORD Financial Responsibility ID Card",
      "permit_number": "",
      "document_category": "INSURANCE",
      "status": "PENDING_ACTIVATION",
      "start_date": "2026-01-12",
      "end_date": "2026-07-12",
      "term_duration": "SIX MONTHS",
      "auto_renew": false,
      "jurisdiction": "PENNSYLVANIA",
      "issuing_authority": "USAA"
    }
- Input Text Snippet: "Charleston Fire Department Operational Permit Sticker. Mobile Food Service Vendor [checked]. Good for 1 yr. from date stamp.. Issued by: Charleston-sc.gov/fm"
  - Output JSON:
    {
      "title": "Charleston Fire Department Operational Permit Sticker",
      "permit_number": "",
      "document_category": "PERMIT",
      "status": "EXPIRED",
      "start_date": "2019-04-07",
      "end_date": "2020-04-07",
      "term_duration": "1 yr.",
      "auto_renew": false,
      "jurisdiction": "Charleston",
      "issuing_authority": "Charleston Fire Department"
    }
- Focus on filling every field with the best available information.
- Respond ONLY with JSON, no commentary.`,
        },
        {
          type: "image_url",
          image_url: {
            url: dataUrl,
          },
        },
      ],
    },
  ];

  const completion = await openai.chat.completions.create({
    model: "gpt-5.1", // or another vision-capable model
    response_format: { type: "json_object" }, // ask for proper JSON
    messages,
  });

  const rawContent = completion.choices[0]?.message?.content;
  if (!rawContent) {
    return NextResponse.json(
      { error: "No content returned from model" },
      { status: 500 }
    );
  }
  console.log("Raw model content:", rawContent);
  // Because we requested json_object format, this should be JSON already.
  let parsed: Record<string, unknown>;

  try {
    parsed = JSON.parse(rawContent);
  } catch (error: unknown) {
    return NextResponse.json(
      {
        error: resolveErrorMessage(error, "Failed to parse JSON from model"),
        rawContent,
      },
      { status: 500 }
    );
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return NextResponse.json(
      { error: "Model response was not an object", rawContent },
      { status: 500 }
    );
  }

  const titleCandidate =
    typeof parsed.title === "string"
      ? parsed.title
      : typeof (parsed as Record<string, unknown>).permit_title === "string"
      ? ((parsed as Record<string, unknown>).permit_title as string)
      : typeof (parsed as Record<string, unknown>).type === "string"
      ? ((parsed as Record<string, unknown>).type as string)
      : "";

  const permitNumberCandidate =
    typeof parsed.permit_number === "string"
      ? parsed.permit_number
      : typeof (parsed as Record<string, unknown>).number === "string"
      ? ((parsed as Record<string, unknown>).number as string)
      : typeof (parsed as Record<string, unknown>).permitNumber === "string"
      ? ((parsed as Record<string, unknown>).permitNumber as string)
      : "";

  const documentCategory = normalizeCategory(
    (parsed as Record<string, unknown>).document_category ??
      (parsed as Record<string, unknown>).category ??
      (parsed as Record<string, unknown>).type
  );

  const status = normalizeStatus((parsed as Record<string, unknown>).status);
  const startDate = normalizeDate(
    (parsed as Record<string, unknown>).start_date ??
      (parsed as Record<string, unknown>).startDate ??
      (parsed as Record<string, unknown>).issued_date ??
      (parsed as Record<string, unknown>).issue_date
  );
  const endDate = normalizeDate(
    (parsed as Record<string, unknown>).end_date ??
      (parsed as Record<string, unknown>).endDate ??
      (parsed as Record<string, unknown>).expiration_date ??
      (parsed as Record<string, unknown>).expiry_date
  );
  const autoRenew = normalizeBoolean(
    (parsed as Record<string, unknown>).auto_renew ??
      (parsed as Record<string, unknown>).autoRenew
  );
  const jurisdictionCandidate =
    typeof (parsed as Record<string, unknown>).jurisdiction === "string"
      ? ((parsed as Record<string, unknown>).jurisdiction as string)
      : typeof (parsed as Record<string, unknown>).jurisdictionName === "string"
      ? ((parsed as Record<string, unknown>).jurisdictionName as string)
      : "";
  const issuingAuthorityCandidate =
    typeof (parsed as Record<string, unknown>).issuing_authority === "string"
      ? ((parsed as Record<string, unknown>).issuing_authority as string)
      : typeof (parsed as Record<string, unknown>).issuingAuthority === "string"
      ? ((parsed as Record<string, unknown>).issuingAuthority as string)
      : "";

  const title = sanitizeAscii(titleCandidate).trim();
  const permitNumber = sanitizeAscii(permitNumberCandidate).trim();
  const jurisdiction = sanitizeAscii(jurisdictionCandidate).trim();
  const issuingAuthority = sanitizeAscii(issuingAuthorityCandidate).trim();

  return NextResponse.json({
    title,
    permitNumber,
    documentCategory,
    status,
    startDate,
    endDate,
    autoRenew,
    jurisdiction,
    issuingAuthority,
    rawFields: parsed,
    sourceFile: sourceFileMeta,
  });
}

async function resolveOrUploadSourceFile(
  formData: FormData,
  options: {
    supabaseStorage: ReturnType<typeof createSupabaseServiceClient>;
    userId: string;
    file: File;
    fileBuffer: Buffer;
  }
): Promise<PermitSourceFileMeta> {
  const { supabaseStorage, userId, file, fileBuffer } = options;

  const existingBucket = formData.get("sourceFileBucket");
  const existingPath = formData.get("sourceFilePath");
  const existingContentType = formData.get("sourceFileContentType");
  const existingName = formData.get("sourceFileName");
  const existingSize = formData.get("sourceFileSize");

  if (typeof existingBucket === "string" && typeof existingPath === "string") {
    if (existingBucket !== PERMIT_FILES_BUCKET || !existingPath.startsWith(`${userId}/`)) {
      throw new SourceFileError("Invalid source file reference", 400);
    }

    const normalizedSize =
      typeof existingSize === "string"
        ? Number.parseInt(existingSize, 10)
        : typeof existingSize === "number"
        ? existingSize
        : undefined;

    return {
      bucket: existingBucket,
      path: existingPath,
      contentType:
        typeof existingContentType === "string" && existingContentType.trim().length > 0
          ? existingContentType
          : file.type || "application/octet-stream",
      name:
        typeof existingName === "string" && existingName.trim().length > 0
          ? existingName
          : file.name || "permit-file",
      size: Number.isFinite(normalizedSize) ? Number(normalizedSize) : file.size,
    };
  }

  const extension = inferExtension(file.name);
  const objectPath = `${userId}/${new Date().toISOString().slice(0, 10)}/${randomUUID()}${extension}`;
  const { error: uploadError } = await supabaseStorage.storage
    .from(PERMIT_FILES_BUCKET)
    .upload(objectPath, fileBuffer, {
      contentType: file.type || "application/octet-stream",
      upsert: false,
    });

  if (uploadError) {
    throw new SourceFileError(uploadError.message || "Failed to store uploaded file", 500);
  }

  return {
    bucket: PERMIT_FILES_BUCKET,
    path: objectPath,
    contentType: file.type || "application/octet-stream",
    name: file.name || "permit-file",
    size: file.size,
  };
}

function inferExtension(fileName?: string | null) {
  if (!fileName) {
    return "";
  }
  const parts = fileName.split(".");
  if (parts.length < 2) {
    return "";
  }
  const ext = parts.pop();
  if (!ext) {
    return "";
  }
  return `.${ext.toLowerCase()}`;
}

class SourceFileError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}
