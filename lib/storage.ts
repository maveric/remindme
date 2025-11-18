export const PERMIT_FILES_BUCKET = "permit-files" as const;

export type PermitSourceFileMeta = {
  bucket: string;
  path: string;
  contentType: string;
  name: string;
  size: number;
};
