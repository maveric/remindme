import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { ensureProfile } from "@/lib/ensure-profile";
import { createSupabaseServiceClient } from "@/lib/supabase/service";
import { PERMIT_FILES_BUCKET } from "@/lib/storage";

export const runtime = "nodejs";

type RouteParams = {
  params: {
    id: string;
    documentId: string;
  };
};

function parseId(source: string): number | null {
  const value = Number(source);
  if (!Number.isFinite(value) || value <= 0) {
    return null;
  }
  return value;
}

export async function GET(_req: Request, { params }: RouteParams) {
  const businessId = parseId(params.id);
  const documentId = parseId(params.documentId);

  if (!businessId || !documentId) {
    return NextResponse.json({ error: "Valid ids are required" }, { status: 400 });
  }

  const supabase = createSupabaseServerClient();
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  await ensureProfile(user);
  const storageClient = createSupabaseServiceClient();

  const document = await prisma.businessDocument.findFirst({
    where: {
      id: documentId,
      businessId,
      business: {
        userId: user.id,
      },
    },
    select: {
      sourceFileBucket: true,
      sourceFilePath: true,
      sourceFileContentType: true,
      sourceFileName: true,
    },
  });

  if (!document) {
    return NextResponse.json({ error: "Permit not found" }, { status: 404 });
  }

  if (!document.sourceFileBucket || !document.sourceFilePath) {
    return NextResponse.json({ error: "No stored file for this permit" }, { status: 404 });
  }

  if (document.sourceFileBucket !== PERMIT_FILES_BUCKET) {
    return NextResponse.json({ error: "Invalid file reference" }, { status: 400 });
  }

  const { data, error: downloadError } = await storageClient.storage
    .from(document.sourceFileBucket)
    .download(document.sourceFilePath);

  if (downloadError || !data) {
    return NextResponse.json({ error: "Unable to load file" }, { status: 502 });
  }

  const buffer = Buffer.from(await data.arrayBuffer());
  const filename = document.sourceFileName ?? "permit-file";
  const contentType = document.sourceFileContentType ?? "application/octet-stream";

  return new NextResponse(buffer, {
    headers: {
      "Content-Type": contentType,
      "Content-Length": String(buffer.byteLength),
      "Content-Disposition": `inline; filename="${encodeURIComponent(filename)}"`,
      "Cache-Control": "private, max-age=0, must-revalidate",
    },
  });
}
