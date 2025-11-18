"use client";

import Image from "next/image";
import { ChangeEvent, FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

type DashboardProfile = {
  id: string;
  email: string | null;
  name: string | null;
  phone: string | null;
};

type Company = {
  id: number;
  name: string;
  phone: string | null;
  notes: string | null;
  businessTypeName: string | null;
  jurisdictionName: string | null;
  createdAt: string;
  updatedAt: string;
};

type CompanyForm = {
  name: string;
  phone: string;
  notes: string;
  businessTypeName: string;
  jurisdictionName: string;
};

const emptyForm: CompanyForm = {
  name: "",
  phone: "",
  notes: "",
  businessTypeName: "",
  jurisdictionName: "",
};

const documentCategories = [
  "PERMIT",
  "LICENSE",
  "INSPECTION",
  "INSURANCE",
  "REGISTRATION",
  "CERTIFICATION",
  "AGREEMENT",
  "OTHER",
] as const;

const documentStatuses = [
  "ACTIVE",
  "PENDING_ACTIVATION",
  "PENDING_RENEWAL",
  "EXPIRED",
  "INACTIVE",
] as const;

const PERMIT_REFRESH_COOLDOWN_MS = 60_000; // 1 minute

type DocumentCategoryValue = (typeof documentCategories)[number];
type DocumentStatusValue = (typeof documentStatuses)[number];

type Permit = {
  id: number;
  businessId: number;
  title: string;
  permitNumber: string | null;
  documentCategory: DocumentCategoryValue;
  status: DocumentStatusValue;
  startDate: string | null;
  endDate: string | null;
  autoRenew: boolean;
  createdAt: string;
  updatedAt: string;
  jurisdictionName: string | null;
  issuingAuthorityName: string | null;
  rawExtractionJson: unknown | null;
  sourceFileBucket: string | null;
  sourceFilePath: string | null;
  sourceFileContentType: string | null;
  sourceFileName: string | null;
  sourceFileSize: number | null;
};

type PermitForm = {
  title: string;
  permitNumber: string;
  documentCategory: DocumentCategoryValue;
  status: DocumentStatusValue;
  startDate: string;
  endDate: string;
  autoRenew: boolean;
  jurisdictionName: string;
  issuingAuthorityName: string;
};

type PermitSourceFileMetaState = {
  bucket: string | null;
  path: string | null;
  contentType: string | null;
  name: string | null;
  size: number | null;
};

const emptyPermitForm: PermitForm = {
  title: "",
  permitNumber: "",
  documentCategory: "PERMIT",
  status: "ACTIVE",
  startDate: "",
  endDate: "",
  autoRenew: false,
  jurisdictionName: "",
  issuingAuthorityName: "",
};

function toDateInputValue(value: string | null): string {
  if (!value) {
    return "";
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return "";
  }
  return parsed.toISOString().slice(0, 10);
}

function formatDisplayDate(value: string | null): string {
  if (!value) {
    return "No end date";
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return "No end date";
  }
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(parsed);
}

function formatStatusLabel(value: DocumentStatusValue): string {
  return value
    .split("_")
    .map((segment) => segment.charAt(0) + segment.slice(1).toLowerCase())
    .join(" ");
}

function formatCategoryLabel(value: DocumentCategoryValue): string {
  return value
    .split("_")
    .map((segment) => segment.charAt(0) + segment.slice(1).toLowerCase())
    .join(" ");
}

function coerceCategoryValue(value?: string | null): DocumentCategoryValue {
  if (value) {
    const normalized = value.trim().toUpperCase();
    if (documentCategories.includes(normalized as DocumentCategoryValue)) {
      return normalized as DocumentCategoryValue;
    }
  }
  return "PERMIT";
}

function coerceStatusValue(value?: string | null): DocumentStatusValue {
  if (value) {
    const normalized = value.trim().toUpperCase().replace(/[\s-]+/g, "_");
    if (documentStatuses.includes(normalized as DocumentStatusValue)) {
      return normalized as DocumentStatusValue;
    }
  }
  return "ACTIVE";
}

function sanitizeDateInput(value?: string | null): string {
  if (!value) {
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

function coerceAutoRenew(value: unknown): boolean {
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

function permitToForm(permit: Permit): PermitForm {
  return {
    title: permit.title,
    permitNumber: permit.permitNumber ?? "",
    documentCategory: permit.documentCategory,
    status: permit.status,
    startDate: toDateInputValue(permit.startDate),
    endDate: toDateInputValue(permit.endDate),
    autoRenew: permit.autoRenew,
    jurisdictionName: permit.jurisdictionName ?? "",
    issuingAuthorityName: permit.issuingAuthorityName ?? "",
  };
}

function extractSourceFileMetaFromPermit(permit: Permit | null): PermitSourceFileMetaState | null {
  if (!permit || !permit.sourceFileBucket || !permit.sourceFilePath) {
    return null;
  }

  return {
    bucket: permit.sourceFileBucket,
    path: permit.sourceFilePath,
    contentType: permit.sourceFileContentType,
    name: permit.sourceFileName,
    size: permit.sourceFileSize,
  };
}

function normalizeSourceFileMetaFromResponse(source: unknown): PermitSourceFileMetaState | null {
  if (!source || typeof source !== "object") {
    return null;
  }

  const meta = source as Record<string, unknown>;
  if (typeof meta.bucket !== "string" || typeof meta.path !== "string") {
    return null;
  }

  return {
    bucket: meta.bucket,
    path: meta.path,
    contentType:
      typeof meta.contentType === "string" && meta.contentType.trim().length > 0
        ? meta.contentType
        : "application/octet-stream",
    name: typeof meta.name === "string" && meta.name.trim().length > 0 ? meta.name : "Permit file",
    size:
      typeof meta.size === "number" && Number.isFinite(meta.size)
        ? meta.size
        : typeof meta.size === "string" && meta.size.trim().length > 0
        ? Number.parseInt(meta.size, 10)
        : null,
  };
}

function hasStoredSourceFile(meta: PermitSourceFileMetaState | null): boolean {
  return Boolean(meta?.bucket && meta.path);
}

function resolveErrorMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return fallback;
}

export default function DashboardPage() {
  const router = useRouter();
  const supabase = useMemo(() => createSupabaseBrowserClient(), []);

  const [profile, setProfile] = useState<DashboardProfile | null>(null);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [selectedCompanyId, setSelectedCompanyId] = useState<number | null>(null);
  const [form, setForm] = useState<CompanyForm>(emptyForm);
  const [createForm, setCreateForm] = useState<CompanyForm>(emptyForm);
  const [isEditModalOpen, setIsEditModalOpen] = useState(false);
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [isFetching, setIsFetching] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [permits, setPermits] = useState<Permit[]>([]);
  const [selectedPermitId, setSelectedPermitId] = useState<number | null>(null);
  const [permitForm, setPermitForm] = useState<PermitForm>(emptyPermitForm);
  const [isPermitCreateMode, setIsPermitCreateMode] = useState(false);
  const [permitLoading, setPermitLoading] = useState(false);
  const [isFetchingPermits, setIsFetchingPermits] = useState(false);
  const [permitExtractionLoading, setPermitExtractionLoading] = useState(false);
  const [permitExtractionRaw, setPermitExtractionRaw] = useState<Record<string, unknown> | null>(null);
  const [permitFilePreview, setPermitFilePreview] = useState<string | null>(null);
  const [permitFileName, setPermitFileName] = useState<string | null>(null);
  const [permitFileType, setPermitFileType] = useState<string | null>(null);
  const [isPermitPreviewOpen, setIsPermitPreviewOpen] = useState(false);
  const [permitSourceFile, setPermitSourceFile] = useState<File | null>(null);
  const [nextPermitRefreshAt, setNextPermitRefreshAt] = useState<number | null>(null);
  const [permitRefreshCountdown, setPermitRefreshCountdown] = useState(0);
  const [permitSourceFileMeta, setPermitSourceFileMeta] = useState<PermitSourceFileMetaState | null>(null);
  const [shouldClearStoredFile, setShouldClearStoredFile] = useState(false);
  const [isStoredFileLoading, setIsStoredFileLoading] = useState(false);
  const [lastLoadedSourcePath, setLastLoadedSourcePath] = useState<string | null>(null);
  const [shouldAutoOpenStoredPreview, setShouldAutoOpenStoredPreview] = useState(false);

  useEffect(() => {
    return () => {
      if (permitFilePreview) {
        URL.revokeObjectURL(permitFilePreview);
      }
    };
  }, [permitFilePreview]);

  useEffect(() => {
    if (!nextPermitRefreshAt) {
      setPermitRefreshCountdown(0);
      return;
    }

    let cancelled = false;

    const updateCountdown = () => {
      const remainingMs = nextPermitRefreshAt - Date.now();
      if (remainingMs <= 0) {
        if (!cancelled) {
          setPermitRefreshCountdown(0);
          setNextPermitRefreshAt(null);
        }
        return;
      }

      if (!cancelled) {
        setPermitRefreshCountdown(Math.ceil(remainingMs / 1000));
      }
    };

    updateCountdown();
    const intervalId = window.setInterval(updateCountdown, 500);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [nextPermitRefreshAt]);

  useEffect(() => {
    let active = true;

    async function loadCompanies() {
      setIsFetching(true);
      setError(null);

      try {
        const response = await fetch("/api/businesses", { cache: "no-store" });

        if (response.status === 401) {
          router.replace("/login");
          return;
        }

        if (!response.ok) {
          const payload = await response.json().catch(() => ({}));
          throw new Error(payload.error || "Failed to load companies");
        }

        const data = (await response.json()) as Company[];

        if (!active) {
          return;
        }

        setCompanies(data);

        if (data.length === 0) {
          setSelectedCompanyId(null);
          setForm(emptyForm);
          setPermits([]);
          setSelectedPermitId(null);
          setPermitForm(emptyPermitForm);
          setIsPermitCreateMode(false);
        } else {
          const first = data[0];
          setSelectedCompanyId(first.id);
          setForm({
            name: first.name,
            phone: first.phone ?? "",
            notes: first.notes ?? "",
            businessTypeName: first.businessTypeName ?? "",
            jurisdictionName: first.jurisdictionName ?? "",
          });
        }
      } catch (err: unknown) {
        if (!active) {
          return;
        }
        setError(resolveErrorMessage(err, "Failed to load companies"));
      } finally {
        if (active) {
          setIsFetching(false);
        }
      }
    }

    async function bootstrap() {
      setError(null);

      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (!session) {
        router.replace("/login");
        return;
      }

      try {
        const profileResponse = await fetch("/api/profile", { cache: "no-store" });

        if (profileResponse.status === 401) {
          router.replace("/login");
          return;
        }

        if (!profileResponse.ok) {
          const payload = await profileResponse.json().catch(() => ({}));
          throw new Error(payload.error || "Failed to load profile");
        }

        const profileData = (await profileResponse.json()) as DashboardProfile;

        if (!active) {
          return;
        }

        setProfile(profileData);
        await loadCompanies();
      } catch (err: unknown) {
        if (!active) {
          return;
        }
        setError(resolveErrorMessage(err, "Failed to load your workspace"));
      } finally {
        // no-op
      }
    }

    bootstrap();

    return () => {
      active = false;
    };
  }, [router, supabase]);

  useEffect(() => {
    if (!selectedCompanyId) {
      return;
    }

    const activeCompany = companies.find((company) => company.id === selectedCompanyId);

    if (!activeCompany) {
      return;
    }

    setForm({
      name: activeCompany.name,
      phone: activeCompany.phone ?? "",
      notes: activeCompany.notes ?? "",
      businessTypeName: activeCompany.businessTypeName ?? "",
      jurisdictionName: activeCompany.jurisdictionName ?? "",
    });
  }, [selectedCompanyId, companies]);

  useEffect(() => {
    let active = true;

    if (!selectedCompanyId) {
      setPermits([]);
      setSelectedPermitId(null);
      setPermitForm(emptyPermitForm);
      setIsPermitCreateMode(false);
      setPermitExtractionRaw(null);
      setPermitExtractionLoading(false);
      clearPermitFileState();
      return;
    }

    async function loadPermits() {
      setIsFetchingPermits(true);

      try {
        const response = await fetch(`/api/businesses/${selectedCompanyId}/documents`, {
          cache: "no-store",
        });

        if (response.status === 401) {
          router.replace("/login");
          return;
        }

        if (!response.ok) {
          const payload = await response.json().catch(() => ({}));
          throw new Error(payload.error || "Failed to load permits");
        }

        const data = (await response.json()) as Permit[];

        if (!active) {
          return;
        }

        setPermits(data);

        if (data.length === 0) {
          setSelectedPermitId(null);
          setPermitForm(emptyPermitForm);
          setIsPermitCreateMode(false);
          setPermitExtractionRaw(null);
          setPermitExtractionLoading(false);
          clearPermitFileState();
          setShouldAutoOpenStoredPreview(false);
        } else {
          const first = data[0];
          setSelectedPermitId(first.id);
          setPermitForm(permitToForm(first));
          setIsPermitCreateMode(false);
          setPermitExtractionRaw(null);
          setPermitExtractionLoading(false);
          clearPermitFileState();
          setPermitSourceFileMeta(extractSourceFileMetaFromPermit(first));
          setShouldClearStoredFile(false);
          setShouldAutoOpenStoredPreview(true);
        }
      } catch (err: unknown) {
        if (!active) {
          return;
        }
        setPermits([]);
        setSelectedPermitId(null);
        setPermitForm(emptyPermitForm);
        setIsPermitCreateMode(false);
        setPermitExtractionRaw(null);
        setPermitExtractionLoading(false);
        clearPermitFileState();
        setError(resolveErrorMessage(err, "Failed to load permits"));
      } finally {
        if (active) {
          setIsFetchingPermits(false);
        }
      }
    }

    loadPermits();

    return () => {
      active = false;
    };
  }, [selectedCompanyId, router]);

  const selectedCompany = useMemo(
    () => companies.find((company) => company.id === selectedCompanyId) ?? null,
    [companies, selectedCompanyId]
  );

  const selectedPermit = useMemo(
    () => (selectedPermitId ? permits.find((permit) => permit.id === selectedPermitId) ?? null : null),
    [permits, selectedPermitId]
  );

  useEffect(() => {
    if (!selectedPermit || isPermitCreateMode) {
      return;
    }

    setPermitExtractionRaw(null);
    setPermitExtractionLoading(false);
    setPermitForm(permitToForm(selectedPermit));
    clearPermitFileState();
    setPermitSourceFileMeta(extractSourceFileMetaFromPermit(selectedPermit));
    setShouldClearStoredFile(false);
  }, [selectedPermit, isPermitCreateMode]);

  function resetCreateForm() {
    setCreateForm(emptyForm);
  }

  function syncFormWithSelectedCompany() {
    if (!selectedCompany) {
      return;
    }
    setForm({
      name: selectedCompany.name,
      phone: selectedCompany.phone ?? "",
      notes: selectedCompany.notes ?? "",
      businessTypeName: selectedCompany.businessTypeName ?? "",
      jurisdictionName: selectedCompany.jurisdictionName ?? "",
    });
  }

  function closeEditModal(restore = true) {
    if (restore) {
      syncFormWithSelectedCompany();
    }
    setIsEditModalOpen(false);
  }

  function closeCreateModal(reset = true) {
    if (reset) {
      resetCreateForm();
    }
    setIsCreateModalOpen(false);
  }

  async function handleUpdate(event: FormEvent) {
    event.preventDefault();
    if (!selectedCompanyId) {
      return;
    }

    setLoading(true);
    setError(null);
    setSuccessMessage(null);

    try {
      const response = await fetch(`/api/businesses/${selectedCompanyId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: form.name.trim(),
          phone: form.phone.trim() || null,
          notes: form.notes.trim() || null,
          businessTypeName: form.businessTypeName.trim(),
          jurisdictionName: form.jurisdictionName.trim(),
        }),
      });

      const payload = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(payload.error || "Failed to update company");
      }

      const updated = payload as Company;

      setCompanies((prev) =>
        prev.map((company) => (company.id === updated.id ? updated : company))
      );
      setSuccessMessage("Company updated successfully");
      closeEditModal(false);
    } catch (err: unknown) {
      setError(resolveErrorMessage(err, "Failed to update company"));
    } finally {
      setLoading(false);
    }
  }

  async function handleDelete() {
    if (!selectedCompanyId) {
      return;
    }

    const confirmDelete = window.confirm("Delete this company? This cannot be undone.");
    if (!confirmDelete) {
      return;
    }

    setLoading(true);
    setError(null);
    setSuccessMessage(null);

    try {
      const response = await fetch(`/api/businesses/${selectedCompanyId}`, {
        method: "DELETE",
      });

      const payload = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(payload.error || "Failed to delete company");
      }

      setCompanies((prev) => prev.filter((company) => company.id !== selectedCompanyId));

      setPermits([]);
      setSelectedPermitId(null);
      setPermitForm(emptyPermitForm);
      setIsPermitCreateMode(false);
      setPermitExtractionRaw(null);
      setPermitExtractionLoading(false);
      clearPermitFileState();

      if (companies.length <= 1) {
        setSelectedCompanyId(null);
        setForm(emptyForm);
      } else {
        const remaining = companies.filter((company) => company.id !== selectedCompanyId);
        const next = remaining[0];
        setSelectedCompanyId(next?.id ?? null);
        if (next) {
          setForm({
            name: next.name,
            phone: next.phone ?? "",
            notes: next.notes ?? "",
            businessTypeName: next.businessTypeName ?? "",
            jurisdictionName: next.jurisdictionName ?? "",
          });
        }
    }

    closeEditModal(false);
    closeCreateModal();
    setSuccessMessage("Company deleted");
    } catch (err: unknown) {
      setError(resolveErrorMessage(err, "Failed to delete company"));
    } finally {
      setLoading(false);
    }
  }

  async function handleCreate(event: FormEvent) {
    event.preventDefault();

    if (!createForm.name.trim()) {
      setError("Company name is required");
      return;
    }

    setLoading(true);
    setError(null);
    setSuccessMessage(null);

    try {
      const response = await fetch("/api/businesses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: createForm.name.trim(),
          phone: createForm.phone.trim() || null,
          notes: createForm.notes.trim() || null,
          businessTypeName: createForm.businessTypeName.trim(),
          jurisdictionName: createForm.jurisdictionName.trim(),
        }),
      });

      const payload = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(payload.error || "Failed to add company");
      }

      const created = payload as Company;

      setCompanies((prev) => [created, ...prev]);
      setSelectedCompanyId(created.id);
      setForm({
        name: created.name,
        phone: created.phone ?? "",
        notes: created.notes ?? "",
        businessTypeName: created.businessTypeName ?? "",
        jurisdictionName: created.jurisdictionName ?? "",
      });
      setPermits([]);
      setSelectedPermitId(null);
      setPermitForm(emptyPermitForm);
      setIsPermitCreateMode(false);
      setPermitExtractionRaw(null);
      setPermitExtractionLoading(false);
      clearPermitFileState();
      closeCreateModal();
      closeEditModal(false);
      setSuccessMessage("Company added successfully");
    } catch (err: unknown) {
      setError(resolveErrorMessage(err, "Failed to add company"));
    } finally {
      setLoading(false);
    }
  }

  function handleSelectChange(event: ChangeEvent<HTMLSelectElement>) {
    const value = event.target.value;

    if (value === "") {
      setSelectedCompanyId(null);
      setForm(emptyForm);
      setPermits([]);
      setSelectedPermitId(null);
      setPermitForm(emptyPermitForm);
      setIsPermitCreateMode(false);
      setPermitExtractionRaw(null);
      setPermitExtractionLoading(false);
      clearPermitFileState();
      setIsEditModalOpen(false);
      setIsCreateModalOpen(false);
      return;
    }

  setSelectedCompanyId(Number(value));
  setIsCreateModalOpen(false);
  setIsEditModalOpen(false);
    setPermits([]);
    setSelectedPermitId(null);
    setPermitForm(emptyPermitForm);
    setIsPermitCreateMode(false);
    setPermitExtractionRaw(null);
    setPermitExtractionLoading(false);
    clearPermitFileState();
  }

  function handlePermitSelect(permitId: number) {
    const exists = permits.find((permit) => permit.id === permitId);
    if (!exists) {
      return;
    }
    setSelectedPermitId(permitId);
    setShouldAutoOpenStoredPreview(true);
    setIsPermitCreateMode(false);
    setSuccessMessage(null);
    setError(null);
    setPermitExtractionRaw(null);
    setPermitExtractionLoading(false);
    clearPermitFileState();
  }

  function handlePermitCancel() {
    setIsPermitCreateMode(false);
    setSelectedPermitId(null);
    setPermitForm(emptyPermitForm);
    setPermitExtractionRaw(null);
    setPermitExtractionLoading(false);
    clearPermitFileState();
  }

  function togglePermitCreateMode() {
    if (!selectedCompanyId) {
      setError("Select or add a company before managing permits");
      return;
    }

    setSuccessMessage(null);
    setError(null);

    setIsPermitCreateMode((previous) => {
      if (previous) {
        setPermitForm(emptyPermitForm);
        setSelectedPermitId(null);
        setPermitExtractionRaw(null);
        setPermitExtractionLoading(false);
        clearPermitFileState();
        return false;
      }

      setPermitForm(emptyPermitForm);
      setSelectedPermitId(null);
      setPermitExtractionRaw(null);
      setPermitExtractionLoading(false);
      clearPermitFileState();
      return true;
    });
  }

  function clearPermitFileState(options?: { preserveRemovalFlag?: boolean }) {
    const preserveRemovalFlag = options?.preserveRemovalFlag ?? false;
    setPermitFilePreview((previous) => {
      if (previous) {
        URL.revokeObjectURL(previous);
      }
      return null;
    });
    setPermitFileName(null);
    setPermitFileType(null);
    setIsPermitPreviewOpen(false);
    setPermitSourceFile(null);
    setNextPermitRefreshAt(null);
    setPermitRefreshCountdown(0);
    setPermitSourceFileMeta(null);
    if (!preserveRemovalFlag) {
      setShouldClearStoredFile(false);
    }
    setLastLoadedSourcePath(null);
    setIsStoredFileLoading(false);
    setShouldAutoOpenStoredPreview(false);
  }

  async function extractPermitFromFile(file: File, options?: { isRefresh?: boolean }) {
    const { isRefresh = false } = options ?? {};
    setPermitExtractionLoading(true);
    setPermitExtractionRaw(null);
    setError(null);
    setSuccessMessage(null);

    const formData = new FormData();
    formData.append("file", file);

    if (
      hasStoredSourceFile(permitSourceFileMeta) &&
      permitSourceFileMeta?.bucket &&
      permitSourceFileMeta.path
    ) {
      formData.append("sourceFileBucket", permitSourceFileMeta.bucket);
      formData.append("sourceFilePath", permitSourceFileMeta.path);
      if (permitSourceFileMeta.contentType) {
        formData.append("sourceFileContentType", permitSourceFileMeta.contentType);
      }
      if (permitSourceFileMeta.name) {
        formData.append("sourceFileName", permitSourceFileMeta.name);
      }
      if (permitSourceFileMeta.size) {
        formData.append("sourceFileSize", String(permitSourceFileMeta.size));
      }
    }

    try {
      const response = await fetch("/api/permits", {
        method: "POST",
        body: formData,
      });

      const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;

      if (response.status === 401) {
        router.replace("/login");
        return false;
      }

      if (!response.ok) {
        throw new Error(
          (payload.error as string | undefined) ||
            (isRefresh ? "Failed to refresh permit details" : "Failed to extract permit details")
        );
      }

      const extracted = payload as {
        title?: string;
        permitNumber?: string;
        documentCategory?: string;
        status?: string;
        startDate?: string;
        endDate?: string;
        autoRenew?: unknown;
        rawFields?: unknown;
        jurisdiction?: string;
        jurisdictionName?: string;
        issuing_authority?: string;
        issuingAuthority?: string;
        sourceFile?: Record<string, unknown>;
      };

      setPermitForm((previous) => {
        const nextCategory =
          typeof extracted.documentCategory === "string"
            ? coerceCategoryValue(extracted.documentCategory)
            : previous.documentCategory;
        const nextStatus =
          typeof extracted.status === "string"
            ? coerceStatusValue(extracted.status)
            : previous.status;
        const nextStartDate =
          typeof extracted.startDate === "string" && extracted.startDate.trim().length > 0
            ? sanitizeDateInput(extracted.startDate)
            : previous.startDate;
        const nextEndDate =
          typeof extracted.endDate === "string" && extracted.endDate.trim().length > 0
            ? sanitizeDateInput(extracted.endDate)
            : previous.endDate;
        const nextAutoRenew =
          extracted.autoRenew === undefined
            ? previous.autoRenew
            : coerceAutoRenew(extracted.autoRenew);
        const jurisdictionValue =
          typeof extracted.jurisdiction === "string" && extracted.jurisdiction.trim().length > 0
            ? extracted.jurisdiction.trim()
            : typeof extracted.jurisdictionName === "string" && extracted.jurisdictionName.trim().length > 0
            ? extracted.jurisdictionName.trim()
            : previous.jurisdictionName;
        const issuingAuthorityValue =
          typeof extracted.issuing_authority === "string" && extracted.issuing_authority.trim().length > 0
            ? extracted.issuing_authority.trim()
            : typeof extracted.issuingAuthority === "string" && extracted.issuingAuthority.trim().length > 0
            ? extracted.issuingAuthority.trim()
            : previous.issuingAuthorityName;

        return {
          title: extracted.title?.trim() || previous.title || "",
          permitNumber: extracted.permitNumber?.trim() || previous.permitNumber || "",
          documentCategory: nextCategory,
          status: nextStatus,
          startDate: nextStartDate,
          endDate: nextEndDate,
          autoRenew: nextAutoRenew,
          jurisdictionName: jurisdictionValue,
          issuingAuthorityName: issuingAuthorityValue,
        };
      });

      setPermitExtractionRaw(
        extracted.rawFields && typeof extracted.rawFields === "object" && !Array.isArray(extracted.rawFields)
          ? (extracted.rawFields as Record<string, unknown>)
          : null
      );

      const sourceMeta = normalizeSourceFileMetaFromResponse(extracted.sourceFile);
      setPermitSourceFileMeta(sourceMeta);
      setShouldClearStoredFile(false);
      setLastLoadedSourcePath(sourceMeta?.path ?? null);

      setIsPermitCreateMode(true);
      setSelectedPermitId(null);
      setSuccessMessage(
        isRefresh
          ? "Permit fields refreshed from the uploaded document."
          : "Permit fields populated. Review and save to store your record."
      );

      return true;
    } catch (err: unknown) {
      setPermitExtractionRaw(null);
      setError(
        resolveErrorMessage(
          err,
          isRefresh ? "Failed to refresh permit details" : "Failed to extract permit details"
        )
      );
      return false;
    } finally {
      setPermitExtractionLoading(false);
    }
  }

  async function handlePermitFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];

    if (!file) {
      return;
    }

    if (!selectedCompanyId) {
      setError("Select or add a company before managing permits");
      event.target.value = "";
      return;
    }

    const previewUrl = URL.createObjectURL(file);
    setPermitFilePreview((previous) => {
      if (previous) {
        URL.revokeObjectURL(previous);
      }
      return previewUrl;
    });
    setPermitFileName(file.name);
    setPermitFileType(file.type);
    setIsPermitPreviewOpen(false);
    setPermitSourceFile(file);
    setNextPermitRefreshAt(null);
    setPermitRefreshCountdown(0);
    setPermitSourceFileMeta(null);
    setShouldClearStoredFile(false);
    setLastLoadedSourcePath(null);

    await extractPermitFromFile(file);
    event.target.value = "";
  }

  async function handlePermitRefresh() {
    if (!permitSourceFile) {
      setError("Upload a permit file before refreshing fields");
      return;
    }

    if (!selectedCompanyId) {
      setError("Select or add a company before refreshing fields");
      return;
    }

    if (permitExtractionLoading) {
      return;
    }

    if (nextPermitRefreshAt && nextPermitRefreshAt - Date.now() > 0) {
      const seconds = Math.ceil((nextPermitRefreshAt - Date.now()) / 1000);
      setError(`Please wait ${seconds}s before refreshing again.`);
      return;
    }

    const success = await extractPermitFromFile(permitSourceFile, { isRefresh: true });
    if (success) {
      const cooldownEnd = Date.now() + PERMIT_REFRESH_COOLDOWN_MS;
      setNextPermitRefreshAt(cooldownEnd);
      setPermitRefreshCountdown(Math.ceil(PERMIT_REFRESH_COOLDOWN_MS / 1000));
    }
  }

  const loadStoredPermitFile = useCallback(
    async (options?: { openPreview?: boolean; silent?: boolean }) => {
      if (!selectedCompanyId || !selectedPermit || !hasStoredSourceFile(permitSourceFileMeta)) {
        return false;
      }

      const { openPreview = false, silent = false } = options ?? {};

      if (!silent) {
        setIsStoredFileLoading(true);
        setError(null);
        setSuccessMessage(null);
      }

      try {
        const response = await fetch(
          `/api/businesses/${selectedCompanyId}/documents/${selectedPermit.id}/file`,
          {
            cache: "no-store",
          }
        );

        if (response.status === 401) {
          router.replace("/login");
          return false;
        }

        if (!response.ok) {
          const payload = await response.json().catch(() => ({}));
          throw new Error((payload as { error?: string }).error || "Unable to load stored file");
        }

        const blob = await response.blob();
        const previewUrl = URL.createObjectURL(blob);

        setPermitFilePreview((previous) => {
          if (previous) {
            URL.revokeObjectURL(previous);
          }
          return previewUrl;
        });
        setPermitFileName(permitSourceFileMeta?.name ?? selectedPermit.title ?? "Permit file");
        setPermitFileType(blob.type || permitSourceFileMeta?.contentType || null);
        setLastLoadedSourcePath(permitSourceFileMeta?.path ?? null);

        if (openPreview) {
          setIsPermitPreviewOpen(true);
        }

        return true;
      } catch (err: unknown) {
        if (silent) {
          console.error("Stored file download failed", err);
        } else {
          setError(resolveErrorMessage(err, "Failed to load stored file"));
        }
        return false;
      } finally {
        if (!silent) {
          setIsStoredFileLoading(false);
        }
      }
    },
    [
      selectedCompanyId,
      selectedPermit,
      permitSourceFileMeta,
      router,
    ]
  );

  function handleRemovePermitFile() {
    if (hasStoredSourceFile(permitSourceFileMeta)) {
      setShouldClearStoredFile(true);
      clearPermitFileState({ preserveRemovalFlag: true });
    } else {
      setShouldClearStoredFile(false);
      clearPermitFileState();
    }
  }

  useEffect(() => {
    if (
      !selectedPermit ||
      isPermitCreateMode ||
      !hasStoredSourceFile(permitSourceFileMeta) ||
      !selectedCompanyId ||
      permitSourceFile
    ) {
      if (shouldAutoOpenStoredPreview) {
        setShouldAutoOpenStoredPreview(false);
      }
      return;
    }

    if (lastLoadedSourcePath && permitSourceFileMeta?.path === lastLoadedSourcePath) {
      if (shouldAutoOpenStoredPreview && permitFilePreview) {
        setIsPermitPreviewOpen(true);
        setShouldAutoOpenStoredPreview(false);
      }
      return;
    }

    let cancelled = false;

    loadStoredPermitFile({
      openPreview: shouldAutoOpenStoredPreview,
      silent: !shouldAutoOpenStoredPreview,
    })
      .then((didLoad) => {
        if (cancelled) {
          return;
        }
        if (shouldAutoOpenStoredPreview && didLoad) {
          setShouldAutoOpenStoredPreview(false);
        }
      })
      .catch((error: unknown) => {
        console.error("Failed to preload stored permit file", error);
      });

    return () => {
      cancelled = true;
    };
  }, [
    selectedPermit,
    isPermitCreateMode,
    permitSourceFileMeta,
    selectedCompanyId,
    permitSourceFile,
    permitFilePreview,
    lastLoadedSourcePath,
    loadStoredPermitFile,
    shouldAutoOpenStoredPreview,
  ]);

  async function handlePermitSubmit(event: FormEvent) {
    event.preventDefault();

    if (!selectedCompanyId) {
      setError("Select or add a company before managing permits");
      return;
    }

    if (!permitForm.title.trim()) {
      setError("Permit title is required");
      return;
    }

    setPermitLoading(true);
    setError(null);
    setSuccessMessage(null);

    const payload: Record<string, unknown> = {
      title: permitForm.title.trim(),
      permitNumber: permitForm.permitNumber.trim() || null,
      documentCategory: permitForm.documentCategory,
      status: permitForm.status,
      startDate: permitForm.startDate || null,
      endDate: permitForm.endDate || null,
      autoRenew: permitForm.autoRenew,
      jurisdictionName: permitForm.jurisdictionName.trim(),
      issuingAuthorityName: permitForm.issuingAuthorityName.trim(),
    };

    if (permitExtractionRaw !== null) {
      payload.rawExtraction = permitExtractionRaw;
    }

    if (shouldClearStoredFile) {
      payload.sourceFileBucket = "";
      payload.sourceFilePath = "";
      payload.sourceFileContentType = "";
      payload.sourceFileName = "";
      payload.sourceFileSize = 0;
    } else if (hasStoredSourceFile(permitSourceFileMeta)) {
      payload.sourceFileBucket = permitSourceFileMeta?.bucket;
      payload.sourceFilePath = permitSourceFileMeta?.path;
      payload.sourceFileContentType =
        permitSourceFileMeta?.contentType ?? "application/octet-stream";
  payload.sourceFileName = permitSourceFileMeta?.name ?? (permitForm.title || "Permit file");
      payload.sourceFileSize = permitSourceFileMeta?.size ?? 0;
    }

    try {
      if (isPermitCreateMode || !selectedPermitId) {
        const response = await fetch(`/api/businesses/${selectedCompanyId}/documents`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });

        const body = await response.json().catch(() => ({}));

        if (response.status === 401) {
          router.replace("/login");
          return;
        }

        if (!response.ok) {
          throw new Error((body as { error?: string }).error || "Failed to add permit");
        }

        const created = body as Permit;
        setPermits((prev) => [created, ...prev]);
        setSelectedPermitId(created.id);
  setShouldAutoOpenStoredPreview(true);
        setPermitForm(permitToForm(created));
        setIsPermitCreateMode(false);
        setPermitExtractionRaw(null);
        clearPermitFileState();
        setPermitSourceFileMeta(extractSourceFileMetaFromPermit(created));
        setShouldClearStoredFile(false);
        setLastLoadedSourcePath(null);
        setSuccessMessage("Permit added successfully");
      } else {
        const response = await fetch(`/api/businesses/${selectedCompanyId}/documents/${selectedPermitId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });

        const body = await response.json().catch(() => ({}));

        if (response.status === 401) {
          router.replace("/login");
          return;
        }

        if (!response.ok) {
          throw new Error((body as { error?: string }).error || "Failed to update permit");
        }

        const updated = body as Permit;
        setPermits((prev) =>
          prev.map((permit) => (permit.id === updated.id ? updated : permit))
        );
        setPermitForm(permitToForm(updated));
        setShouldAutoOpenStoredPreview(true);
        setPermitExtractionRaw(null);
        clearPermitFileState();
        setPermitSourceFileMeta(extractSourceFileMetaFromPermit(updated));
        setShouldClearStoredFile(false);
        setLastLoadedSourcePath(null);
        setSuccessMessage("Permit updated successfully");
      }
    } catch (err: unknown) {
      setError(
        resolveErrorMessage(
          err,
          isPermitCreateMode || !selectedPermitId
            ? "Failed to add permit"
            : "Failed to update permit"
        )
      );
    } finally {
      setPermitLoading(false);
    }
  }

  async function handleSignOut() {
    await supabase.auth.signOut();
    setProfile(null);
    router.replace("/login");
  }

  const hasCompanies = companies.length > 0;
  const hasActiveCompany = Boolean(selectedCompany);
  const showPermitForm = isPermitCreateMode || selectedPermitId !== null;
  const addPermitButtonLabel = isPermitCreateMode ? "Close new permit" : "Add permit";
  const permitFormSubmitLabel = isPermitCreateMode || !selectedPermitId ? "Add permit" : "Save permit";
  const activeCompanyLabel = hasActiveCompany
    ? selectedCompany?.name ?? ""
    : hasCompanies
    ? "Select a company"
    : "Add your first company";
  const isImagePreview = Boolean(permitFileType?.startsWith("image/"));
  const isPdfPreview =
    permitFileType === "application/pdf" || (permitFileName?.toLowerCase().endsWith(".pdf") ?? false);
  const storedFileAvailable = hasStoredSourceFile(permitSourceFileMeta);
  const storedFileSizeLabel =
    permitSourceFileMeta?.size && permitSourceFileMeta.size > 0
      ? permitSourceFileMeta.size >= 1_048_576
        ? `${(permitSourceFileMeta.size / 1_048_576).toFixed(2)} MB`
        : `${(permitSourceFileMeta.size / 1024).toFixed(1)} KB`
      : null;
  const showStoredFileActions = storedFileAvailable;
  const storedFileActionLabel = isStoredFileLoading
    ? "Loading document…"
    : permitFilePreview && permitSourceFileMeta?.path === lastLoadedSourcePath
    ? "Reopen stored document"
    : "View stored document";
  const permitPreviewTitle = permitFileName ?? permitSourceFileMeta?.name ?? "Permit file";
  const refreshButtonLabel =
    permitRefreshCountdown > 0
      ? `Refresh fields (${permitRefreshCountdown}s)`
      : "Refresh fields";
  const isRefreshButtonDisabled =
    !permitSourceFile || permitExtractionLoading || permitRefreshCountdown > 0 || !hasActiveCompany;

  return (
    <main className="min-h-screen bg-gradient-to-b from-slate-50 via-white to-white px-4 py-12 text-slate-900 transition-colors duration-300 dark:from-slate-950 dark:via-slate-900 dark:to-slate-950 dark:text-slate-100">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-10 sm:gap-12">
        <header className="rounded-3xl border border-slate-200/60 bg-white/80 px-6 py-8 shadow-lg shadow-slate-200/50 backdrop-blur dark:border-slate-800/60 dark:bg-slate-900/60 dark:shadow-black/40 sm:px-10 sm:py-12">
          <div className="flex flex-col gap-2">
            <span className="text-xs font-semibold uppercase tracking-[0.4em] text-slate-400 dark:text-slate-500">
              Dashboard
            </span>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h1 className="text-3xl font-semibold sm:text-4xl">
                  {profile ? `Welcome back, ${profile.name ?? profile.email ?? "there"}` : "Permit Buddy workspace"}
                </h1>
                <p className="text-sm text-slate-600 dark:text-slate-400">
                  Manage your companies before uploading permits. Each document will be linked to the company you
                  create here.
                </p>
              </div>
              <div className="inline-flex gap-3">
                <button
                  type="button"
                  onClick={() => router.push("/settings")}
                  className="rounded-full border border-slate-300 px-4 py-2 text-xs font-semibold uppercase tracking-wide text-slate-600 transition hover:border-slate-400 hover:text-slate-900 dark:border-slate-700 dark:text-slate-300 dark:hover:border-slate-500 dark:hover:text-slate-100"
                >
                  Account settings
                </button>
                <button
                  type="button"
                  onClick={handleSignOut}
                  className="rounded-full bg-red-500 px-4 py-2 text-xs font-semibold uppercase tracking-wide text-white shadow-lg shadow-red-500/30 transition hover:bg-red-400 focus:outline-none focus:ring-4 focus:ring-red-500/30"
                >
                  Sign out
                </button>
              </div>
            </div>
          </div>
        </header>

        <section className="rounded-3xl border border-slate-200/60 bg-white/80 p-6 shadow-2xl shadow-slate-200/60 backdrop-blur dark:border-slate-800/60 dark:bg-slate-900/60 dark:shadow-black/40 sm:p-10">
          <div className="flex flex-col gap-6">
            <div className="rounded-2xl border border-slate-200/70 bg-white/70 px-5 py-4 shadow-inner dark:border-slate-800/70 dark:bg-slate-900/40">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                <div className="flex flex-col gap-1">
                  <span className="text-xs font-semibold uppercase tracking-[0.3em] text-slate-500 dark:text-slate-400">
                    Active company
                  </span>
                  <p className="text-lg font-semibold text-slate-900 dark:text-slate-100">{activeCompanyLabel}</p>
                  {selectedCompany?.notes && (
                    <p className="text-sm text-slate-600 dark:text-slate-400">{selectedCompany.notes}</p>
                  )}
                </div>
                <div className="flex w-full max-w-xs flex-col gap-3 sm:items-end">
                  <label className="flex flex-col gap-2 text-xs font-semibold uppercase tracking-[0.25em] text-slate-500 dark:text-slate-400">
                    <span>Switch</span>
                    <select
                      value={selectedCompanyId ?? ""}
                      onChange={handleSelectChange}
                      disabled={isFetching || !hasCompanies}
                      className="w-full rounded-2xl border border-slate-300 bg-white/80 px-3 py-2 text-sm font-medium text-slate-900 shadow-inner transition focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-200 disabled:cursor-not-allowed disabled:opacity-60 dark:border-slate-700 dark:bg-slate-900/60 dark:text-slate-100 dark:focus:border-blue-400 dark:focus:ring-blue-500/30"
                    >
                      {hasCompanies ? (
                        companies.map((company) => (
                          <option key={company.id} value={company.id}>
                            {company.name}
                          </option>
                        ))
                      ) : (
                        <option value="">No companies yet</option>
                      )}
                    </select>
                  </label>
                  <div className="flex flex-wrap gap-2 self-start sm:self-end">
                    {hasActiveCompany && selectedCompany && (
                      <button
                        type="button"
                        onClick={() => {
                          syncFormWithSelectedCompany();
                          setError(null);
                          setSuccessMessage(null);
                          setIsCreateModalOpen(false);
                          setIsEditModalOpen(true);
                        }}
                        disabled={isFetching || loading}
                        className="inline-flex items-center justify-center rounded-full border border-slate-300 px-4 py-2 text-xs font-semibold uppercase tracking-wide text-slate-600 transition hover:border-slate-400 hover:text-slate-900 disabled:cursor-not-allowed disabled:opacity-60 dark:border-slate-700 dark:text-slate-300 dark:hover:border-slate-500 dark:hover:text-slate-100"
                      >
                        Edit company
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => {
                        resetCreateForm();
                        setError(null);
                        setSuccessMessage(null);
                        setIsEditModalOpen(false);
                        setIsCreateModalOpen(true);
                      }}
                      disabled={isFetching}
                      className="inline-flex items-center justify-center rounded-full bg-gradient-to-r from-emerald-500 to-emerald-600 px-4 py-2 text-xs font-semibold uppercase tracking-wide text-white shadow-md shadow-emerald-500/20 transition hover:from-emerald-400 hover:to-emerald-500 focus:outline-none focus:ring-4 focus:ring-emerald-500/30 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      Add company
                    </button>
                  </div>
                </div>
              {selectedCompany?.phone && (
                <div className="mt-3 text-sm text-slate-500 dark:text-slate-400">
                  <span className="font-medium text-slate-600 dark:text-slate-300">Phone:</span> {selectedCompany.phone}
                </div>
              )}
              {(selectedCompany?.businessTypeName || selectedCompany?.jurisdictionName) && (
                <div className="mt-3 flex flex-col gap-1 text-sm text-slate-500 dark:text-slate-400">
                  {selectedCompany?.businessTypeName && (
                    <span>
                      <span className="font-medium text-slate-600 dark:text-slate-300">Business type:</span> {selectedCompany.businessTypeName}
                    </span>
                  )}
                  {selectedCompany?.jurisdictionName && (
                    <span>
                      <span className="font-medium text-slate-600 dark:text-slate-300">Jurisdiction:</span> {selectedCompany.jurisdictionName}
                    </span>
                  )}
                </div>
              )}
            </div>
          </div>

            {error && (
              <div className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-800/60 dark:bg-red-950/40 dark:text-red-300">
                {error}
              </div>
            )}

            {successMessage && (
              <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-700 dark:border-emerald-600/40 dark:bg-emerald-900/20 dark:text-emerald-200">
                {successMessage}
              </div>
            )}

            <div className="rounded-3xl border border-slate-200/60 bg-white/80 p-6 shadow-2xl shadow-slate-200/60 dark:border-slate-800/60 dark:bg-slate-900/60 dark:shadow-black/40">
              <div className="flex flex-col gap-5">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <span className="text-xs font-semibold uppercase tracking-[0.3em] text-slate-500 dark:text-slate-400">
                      Permits
                    </span>
                    <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
                      Manage permits for this company
                    </h2>
                    <p className="text-sm text-slate-600 dark:text-slate-400">
                      Track permit details and keep renewal dates up to date.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={togglePermitCreateMode}
                    disabled={!hasActiveCompany || isFetchingPermits}
                    className="inline-flex items-center justify-center rounded-full bg-gradient-to-r from-blue-600 to-indigo-600 px-5 py-2 text-sm font-semibold text-white shadow-md shadow-blue-600/20 transition hover:from-blue-500 hover:to-indigo-500 disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {addPermitButtonLabel}
                  </button>
                </div>

                <div className="rounded-2xl border border-dashed border-slate-300 bg-white/60 p-4 text-sm shadow-inner dark:border-slate-700 dark:bg-slate-900/40">
                  <label className="flex flex-col gap-2">
                    <span className="font-semibold text-slate-700 dark:text-slate-200">
                      Upload a permit file to auto-fill this form
                    </span>
                    <span className="text-xs text-slate-500 dark:text-slate-400">
                      Supports images or PDFs. We will analyze the document and populate the fields above.
                    </span>
                    <div className="flex flex-wrap items-center gap-3">
                      <input
                        type="file"
                        accept="image/*,application/pdf"
                        onChange={handlePermitFileChange}
                        disabled={!hasActiveCompany || permitExtractionLoading}
                        className="block w-full max-w-xs cursor-pointer rounded-full border border-slate-200 bg-white px-4 py-1 text-xs font-semibold uppercase tracking-wide text-slate-600 transition hover:border-slate-400 hover:text-slate-800 disabled:cursor-not-allowed disabled:opacity-60 dark:border-slate-700 dark:bg-slate-900/60 dark:text-slate-300 dark:hover:border-slate-500 dark:hover:text-slate-100"
                      />
                      {permitExtractionLoading && (
                        <span className="text-xs font-medium text-blue-600 dark:text-blue-300">
                          Extracting permit details…
                        </span>
                      )}
                    </div>
                  </label>
                  {permitFilePreview && (
                    <div className="mt-4 flex flex-col gap-2 rounded-2xl border border-slate-200 bg-white/70 p-3 text-xs text-slate-600 shadow-inner dark:border-slate-700 dark:bg-slate-900/60 dark:text-slate-300">
                      <div className="flex flex-wrap items-center gap-3">
                        <button
                          type="button"
                          onClick={() => setIsPermitPreviewOpen(true)}
                          className="flex items-center justify-center overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm transition hover:border-slate-400 dark:border-slate-700 dark:bg-slate-900/60 dark:hover:border-slate-500"
                        >
                          {permitFileType && permitFileType.startsWith("image/") ? (
                            <Image
                              src={permitFilePreview}
                              alt="Uploaded permit preview"
                              width={80}
                              height={80}
                              className="h-20 w-20 object-cover"
                              unoptimized
                            />
                          ) : (
                            <div className="flex h-20 w-20 flex-col items-center justify-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                              <span className="text-lg">📄</span>
                              <span>Preview</span>
                            </div>
                          )}
                        </button>
                        <div className="flex flex-col gap-2">
                          <span className="font-semibold text-slate-700 dark:text-slate-200">
                            {permitFileName ?? "Uploaded file"}
                          </span>
                          <div className="flex flex-wrap gap-2">
                            <button
                              type="button"
                              onClick={() => setIsPermitPreviewOpen(true)}
                              className="rounded-full border border-slate-300 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-slate-600 transition hover:border-slate-400 hover:text-slate-800 dark:border-slate-700 dark:text-slate-300 dark:hover:border-slate-500 dark:hover:text-slate-100"
                            >
                              Open preview
                            </button>
                            <button
                              type="button"
                              onClick={handleRemovePermitFile}
                              className="rounded-full border border-red-300 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-red-600 transition hover:border-red-400 hover:text-red-700 dark:border-red-700 dark:text-red-300 dark:hover:border-red-500 dark:hover:text-red-200"
                            >
                              Remove file
                            </button>
                          </div>
                        </div>
                      </div>
                    </div>
                  )}
                  {showStoredFileActions && (
                    <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-white/70 p-3 text-xs text-slate-600 shadow-inner dark:border-slate-700 dark:bg-slate-900/60 dark:text-slate-300">
                      <div className="flex flex-col">
                        <span className="font-semibold text-slate-700 dark:text-slate-200">Stored document available</span>
                        <span className="text-[11px] text-slate-500 dark:text-slate-400">
                          {permitSourceFileMeta?.name ?? "Permit file"}
                          {storedFileSizeLabel ? ` • ${storedFileSizeLabel}` : ""}
                          {permitFilePreview && permitSourceFileMeta?.path === lastLoadedSourcePath
                            ? " • Preview cached"
                            : ""}
                        </span>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <button
                          type="button"
                          onClick={() => {
                            setShouldAutoOpenStoredPreview(false);
                            void loadStoredPermitFile({ openPreview: true, silent: false });
                          }}
                          disabled={isStoredFileLoading}
                          className="rounded-full border border-slate-300 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-slate-600 transition hover:border-slate-400 hover:text-slate-800 disabled:cursor-not-allowed disabled:opacity-60 dark:border-slate-700 dark:text-slate-300 dark:hover:border-slate-500 dark:hover:text-slate-100"
                        >
                          {storedFileActionLabel}
                        </button>
                        <button
                          type="button"
                          onClick={handleRemovePermitFile}
                          className="rounded-full border border-red-300 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-red-600 transition hover:border-red-400 hover:text-red-700 dark:border-red-700 dark:text-red-300 dark:hover:border-red-500 dark:hover:text-red-200"
                        >
                          Remove stored file
                        </button>
                      </div>
                    </div>
                  )}
                </div>

                {!hasActiveCompany ? (
                  <div className="rounded-2xl border border-dashed border-slate-300 bg-white/70 p-6 text-sm text-slate-500 dark:border-slate-700 dark:bg-slate-900/40 dark:text-slate-400">
                    Add a company to start tracking permits.
                  </div>
                ) : isFetchingPermits ? (
                  <div className="rounded-2xl border border-dashed border-slate-300 bg-white/60 p-5 text-sm text-slate-500 dark:border-slate-700 dark:bg-slate-900/30 dark:text-slate-400">
                    Loading permits…
                  </div>
                ) : (
                  <>
                    {permits.length > 0 && (
                      <div className="grid gap-2">
                        {permits.map((permit) => {
                          const isActive = selectedPermitId === permit.id && !isPermitCreateMode;
                          const hasStoredFileBadge = Boolean(permit.sourceFileBucket && permit.sourceFilePath);
                          return (
                            <button
                              key={permit.id}
                              type="button"
                              onClick={() => handlePermitSelect(permit.id)}
                              className={`flex flex-col gap-1 rounded-2xl border px-4 py-3 text-left transition ${
                                isActive
                                  ? "border-blue-500 bg-blue-50/70 text-blue-900 dark:border-blue-400 dark:bg-blue-900/30 dark:text-blue-100"
                                  : "border-slate-200 bg-white/70 text-slate-700 hover:border-slate-300 hover:bg-white dark:border-slate-700 dark:bg-slate-900/50 dark:text-slate-200 dark:hover:border-slate-600"
                              }`}
                            >
                              <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                                <span className="text-sm font-semibold">{permit.title}</span>
                                <span className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                                  {formatStatusLabel(permit.status)}
                                </span>
                              </div>
                              <div className="flex flex-col gap-1 text-xs text-slate-500 dark:text-slate-400 sm:flex-row sm:items-center sm:justify-between">
                                <span>Category: {formatCategoryLabel(permit.documentCategory)}</span>
                                <span>
                                  {permit.endDate ? `Expires ${formatDisplayDate(permit.endDate)}` : "No end date"}
                                </span>
                              </div>
                              {hasStoredFileBadge && (
                                <span className="inline-flex w-fit items-center gap-1 rounded-full bg-slate-900/5 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-500 dark:bg-slate-100/10 dark:text-slate-300">
                                  📎 Stored file attached
                                </span>
                              )}
                              {permit.permitNumber && (
                                <span className="text-xs text-slate-400 dark:text-slate-500">Permit #{permit.permitNumber}</span>
                              )}
                              {(permit.jurisdictionName || permit.issuingAuthorityName) && (
                                <div className="flex flex-col gap-0.5 text-xs text-slate-400 dark:text-slate-500">
                                  {permit.jurisdictionName && <span>Jurisdiction: {permit.jurisdictionName}</span>}
                                  {permit.issuingAuthorityName && (
                                    <span>Issuing authority: {permit.issuingAuthorityName}</span>
                                  )}
                                </div>
                              )}
                            </button>
                          );
                        })}
                      </div>
                    )}

                    {permits.length === 0 && !showPermitForm && (
                      <div className="rounded-2xl border border-dashed border-slate-300 bg-white/70 p-6 text-sm text-slate-500 dark:border-slate-700 dark:bg-slate-900/40 dark:text-slate-400">
                        No permits yet. Use “Add permit” to create your first record.
                      </div>
                    )}

                    {showPermitForm && (
                      <form
                        onSubmit={handlePermitSubmit}
                        className="space-y-5 rounded-2xl border border-slate-200/70 bg-white/70 p-5 shadow-inner dark:border-slate-800/70 dark:bg-slate-900/40"
                      >
                        <div className="grid gap-4 sm:grid-cols-2">
                          <label className="flex flex-col gap-2 text-sm sm:col-span-2">
                            <span className="font-medium text-slate-700 dark:text-slate-200">Title</span>
                            <input
                              value={permitForm.title}
                              onChange={(event) => setPermitForm((prev) => ({ ...prev, title: event.target.value }))}
                              className="rounded-2xl border border-slate-300 bg-white/80 px-3 py-2 text-sm text-slate-900 shadow-inner transition focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-200 dark:border-slate-700 dark:bg-slate-900/60 dark:text-slate-100 dark:focus:border-blue-400 dark:focus:ring-blue-500/30"
                              placeholder="Fire safety permit"
                              required
                            />
                          </label>

                          <label className="flex flex-col gap-2 text-sm">
                            <span className="font-medium text-slate-700 dark:text-slate-200">Permit number</span>
                            <input
                              value={permitForm.permitNumber}
                              onChange={(event) => setPermitForm((prev) => ({ ...prev, permitNumber: event.target.value }))}
                              className="rounded-2xl border border-slate-300 bg-white/80 px-3 py-2 text-sm text-slate-900 shadow-inner transition focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-200 dark:border-slate-700 dark:bg-slate-900/60 dark:text-slate-100 dark:focus:border-blue-400 dark:focus:ring-blue-500/30"
                              placeholder="ABC-12345"
                            />
                          </label>

                          <label className="flex flex-col gap-2 text-sm">
                            <span className="font-medium text-slate-700 dark:text-slate-200">Jurisdiction</span>
                            <input
                              value={permitForm.jurisdictionName}
                              onChange={(event) =>
                                setPermitForm((prev) => ({ ...prev, jurisdictionName: event.target.value }))
                              }
                              className="rounded-2xl border border-slate-300 bg-white/80 px-3 py-2 text-sm text-slate-900 shadow-inner transition focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-200 dark:border-slate-700 dark:bg-slate-900/60 dark:text-slate-100 dark:focus:border-blue-400 dark:focus:ring-blue-500/30"
                              placeholder="City of Exampleville"
                            />
                          </label>

                          <label className="flex flex-col gap-2 text-sm">
                            <span className="font-medium text-slate-700 dark:text-slate-200">Issuing authority</span>
                            <input
                              value={permitForm.issuingAuthorityName}
                              onChange={(event) =>
                                setPermitForm((prev) => ({ ...prev, issuingAuthorityName: event.target.value }))
                              }
                              className="rounded-2xl border border-slate-300 bg-white/80 px-3 py-2 text-sm text-slate-900 shadow-inner transition focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-200 dark:border-slate-700 dark:bg-slate-900/60 dark:text-slate-100 dark:focus:border-blue-400 dark:focus:ring-blue-500/30"
                              placeholder="Dept. of Building Safety"
                            />
                          </label>

                          <label className="flex flex-col gap-2 text-sm">
                            <span className="font-medium text-slate-700 dark:text-slate-200">Category</span>
                            <select
                              value={permitForm.documentCategory}
                              onChange={(event) =>
                                setPermitForm((prev) => ({
                                  ...prev,
                                  documentCategory: event.target.value as DocumentCategoryValue,
                                }))
                              }
                              className="rounded-2xl border border-slate-300 bg-white/80 px-3 py-2 text-sm text-slate-900 shadow-inner transition focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-200 dark:border-slate-700 dark:bg-slate-900/60 dark:text-slate-100 dark:focus:border-blue-400 dark:focus:ring-blue-500/30"
                            >
                              {documentCategories.map((category) => (
                                <option key={category} value={category}>
                                  {formatCategoryLabel(category)}
                                </option>
                              ))}
                            </select>
                          </label>

                          <label className="flex flex-col gap-2 text-sm">
                            <span className="font-medium text-slate-700 dark:text-slate-200">Status</span>
                            <select
                              value={permitForm.status}
                              onChange={(event) =>
                                setPermitForm((prev) => ({
                                  ...prev,
                                  status: event.target.value as DocumentStatusValue,
                                }))
                              }
                              className="rounded-2xl border border-slate-300 bg-white/80 px-3 py-2 text-sm text-slate-900 shadow-inner transition focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-200 dark:border-slate-700 dark:bg-slate-900/60 dark:text-slate-100 dark:focus:border-blue-400 dark:focus:ring-blue-500/30"
                            >
                              {documentStatuses.map((status) => (
                                <option key={status} value={status}>
                                  {formatStatusLabel(status)}
                                </option>
                              ))}
                            </select>
                          </label>

                          <label className="flex flex-col gap-2 text-sm">
                            <span className="font-medium text-slate-700 dark:text-slate-200">Start date</span>
                            <input
                              type="date"
                              value={permitForm.startDate}
                              onChange={(event) => setPermitForm((prev) => ({ ...prev, startDate: event.target.value }))}
                              className="rounded-2xl border border-slate-300 bg-white/80 px-3 py-2 text-sm text-slate-900 shadow-inner transition focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-200 dark:border-slate-700 dark:bg-slate-900/60 dark:text-slate-100 dark:focus:border-blue-400 dark:focus:ring-blue-500/30"
                            />
                          </label>

                          <label className="flex flex-col gap-2 text-sm">
                            <span className="font-medium text-slate-700 dark:text-slate-200">End date</span>
                            <input
                              type="date"
                              value={permitForm.endDate}
                              onChange={(event) => setPermitForm((prev) => ({ ...prev, endDate: event.target.value }))}
                              className="rounded-2xl border border-slate-300 bg-white/80 px-3 py-2 text-sm text-slate-900 shadow-inner transition focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-200 dark:border-slate-700 dark:bg-slate-900/60 dark:text-slate-100 dark:focus:border-blue-400 dark:focus:ring-blue-500/30"
                            />
                          </label>
                        </div>

                        <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-200">
                          <input
                            type="checkbox"
                            checked={permitForm.autoRenew}
                            onChange={(event) =>
                              setPermitForm((prev) => ({ ...prev, autoRenew: event.target.checked }))
                            }
                            className="h-4 w-4 rounded border border-slate-300 text-blue-600 focus:ring-blue-500 dark:border-slate-600"
                          />
                          <span>Enable auto-renew reminders</span>
                        </label>

                        <div className="flex flex-wrap gap-3">
                          <button
                            type="submit"
                            disabled={permitLoading}
                            className="inline-flex items-center justify-center rounded-full bg-gradient-to-r from-blue-600 to-indigo-600 px-5 py-2 text-sm font-semibold text-white shadow-md shadow-blue-600/20 transition hover:from-blue-500 hover:to-indigo-500 disabled:cursor-wait disabled:opacity-60"
                          >
                            {permitLoading ? "Saving…" : permitFormSubmitLabel}
                          </button>

                          <button
                            type="button"
                            onClick={handlePermitRefresh}
                            disabled={isRefreshButtonDisabled}
                            className="inline-flex items-center justify-center rounded-full border border-blue-200 px-5 py-2 text-sm font-semibold text-blue-700 transition hover:border-blue-400 hover:text-blue-900 disabled:cursor-not-allowed disabled:opacity-60 dark:border-blue-500/60 dark:text-blue-200 dark:hover:border-blue-400 dark:hover:text-white"
                          >
                            {refreshButtonLabel}
                          </button>

                          <button
                            type="button"
                            onClick={handlePermitCancel}
                            className="inline-flex items-center justify-center rounded-full border border-slate-300 px-5 py-2 text-sm font-semibold text-slate-600 transition hover:border-slate-400 hover:text-slate-800 dark:border-slate-700 dark:text-slate-300 dark:hover:border-slate-500 dark:hover:text-slate-100"
                          >
                            Cancel
                          </button>
                        </div>
                      </form>
                    )}
                  </>
                )}
              </div>
            </div>
          </div>
        </section>
      </div>
      {isEditModalOpen && selectedCompany && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <button
            type="button"
            className="absolute inset-0 bg-slate-950/60 backdrop-blur-sm"
            onClick={() => {
              if (loading) {
                return;
              }
              closeEditModal();
            }}
            aria-label="Close edit company modal"
          />
          <div className="relative z-10 w-full max-w-lg rounded-3xl border border-slate-200 bg-white p-6 shadow-2xl shadow-slate-900/30 dark:border-slate-700 dark:bg-slate-900">
            <div className="mb-4 flex items-center justify-between gap-3">
              <h3 className="text-lg font-semibold text-slate-900 dark:text-slate-100">Edit company</h3>
              <button
                type="button"
                onClick={() => {
                  if (loading) {
                    return;
                  }
                  closeEditModal();
                }}
                className="rounded-full border border-slate-300 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-slate-600 transition hover:border-slate-400 hover:text-slate-800 disabled:cursor-not-allowed disabled:opacity-60 dark:border-slate-600 dark:text-slate-300 dark:hover:border-slate-500 dark:hover:text-slate-100"
                disabled={loading}
              >
                Close
              </button>
            </div>
            <form onSubmit={handleUpdate} className="space-y-5">
              <div className="space-y-3">
                <label className="flex flex-col gap-2 text-sm">
                  <span className="font-medium text-slate-700 dark:text-slate-200">Company name</span>
                  <input
                    value={form.name}
                    onChange={(event) => setForm((prev) => ({ ...prev, name: event.target.value }))}
                    className="rounded-2xl border border-slate-300 bg-white/80 px-3 py-2 text-sm text-slate-900 shadow-inner transition focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-200 dark:border-slate-700 dark:bg-slate-900/60 dark:text-slate-100 dark:focus:border-blue-400 dark:focus:ring-blue-500/30"
                    placeholder="Acme Holdings"
                    required
                  />
                </label>

                <label className="flex flex-col gap-2 text-sm">
                  <span className="font-medium text-slate-700 dark:text-slate-200">Phone (optional)</span>
                  <input
                    value={form.phone}
                    onChange={(event) => setForm((prev) => ({ ...prev, phone: event.target.value }))}
                    className="rounded-2xl border border-slate-300 bg-white/80 px-3 py-2 text-sm text-slate-900 shadow-inner transition focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-200 dark:border-slate-700 dark:bg-slate-900/60 dark:text-slate-100 dark:focus:border-blue-400 dark:focus:ring-blue-500/30"
                    placeholder="(555) 123-4567"
                  />
                </label>

                <label className="flex flex-col gap-2 text-sm">
                  <span className="font-medium text-slate-700 dark:text-slate-200">Business type</span>
                  <input
                    value={form.businessTypeName}
                    onChange={(event) => setForm((prev) => ({ ...prev, businessTypeName: event.target.value }))}
                    className="rounded-2xl border border-slate-300 bg-white/80 px-3 py-2 text-sm text-slate-900 shadow-inner transition focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-200 dark:border-slate-700 dark:bg-slate-900/60 dark:text-slate-100 dark:focus:border-blue-400 dark:focus:ring-blue-500/30"
                    placeholder="Restaurant"
                  />
                </label>

                <label className="flex flex-col gap-2 text-sm">
                  <span className="font-medium text-slate-700 dark:text-slate-200">Primary jurisdiction</span>
                  <input
                    value={form.jurisdictionName}
                    onChange={(event) => setForm((prev) => ({ ...prev, jurisdictionName: event.target.value }))}
                    className="rounded-2xl border border-slate-300 bg-white/80 px-3 py-2 text-sm text-slate-900 shadow-inner transition focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-200 dark:border-slate-700 dark:bg-slate-900/60 dark:text-slate-100 dark:focus:border-blue-400 dark:focus:ring-blue-500/30"
                    placeholder="City of Exampleville"
                  />
                </label>

                <label className="flex flex-col gap-2 text-sm">
                  <span className="font-medium text-slate-700 dark:text-slate-200">Notes</span>
                  <textarea
                    value={form.notes}
                    onChange={(event) => setForm((prev) => ({ ...prev, notes: event.target.value }))}
                    rows={4}
                    className="rounded-2xl border border-slate-300 bg-white/80 px-3 py-2 text-sm text-slate-900 shadow-inner transition focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-200 dark:border-slate-700 dark:bg-slate-900/60 dark:text-slate-100 dark:focus:border-blue-400 dark:focus:ring-blue-500/30"
                    placeholder="Internal notes or renewal reminders"
                  />
                </label>
              </div>

              <div className="flex flex-wrap gap-3">
                <button
                  type="submit"
                  disabled={loading}
                  className="inline-flex items-center justify-center rounded-full bg-gradient-to-r from-blue-600 to-indigo-600 px-5 py-2 text-sm font-semibold text-white shadow-md shadow-blue-600/20 transition hover:from-blue-500 hover:to-indigo-500 disabled:cursor-wait disabled:opacity-60"
                >
                  {loading ? "Saving…" : "Save changes"}
                </button>

                <button
                  type="button"
                  onClick={() => closeEditModal()}
                  disabled={loading}
                  className="inline-flex items-center justify-center rounded-full border border-slate-300 px-5 py-2 text-sm font-semibold text-slate-600 transition hover:border-slate-400 hover:text-slate-800 disabled:cursor-not-allowed disabled:opacity-60 dark:border-slate-700 dark:text-slate-300 dark:hover:border-slate-500 dark:hover:text-slate-100"
                >
                  Cancel
                </button>

                <button
                  type="button"
                  onClick={handleDelete}
                  disabled={loading}
                  className="inline-flex items-center justify-center rounded-full border border-red-300 px-5 py-2 text-sm font-semibold text-red-600 transition hover:border-red-400 hover:text-red-700 disabled:cursor-not-allowed disabled:opacity-60 dark:border-red-700 dark:text-red-300 dark:hover:border-red-500 dark:hover:text-red-200"
                >
                  Delete company
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {isCreateModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <button
            type="button"
            className="absolute inset-0 bg-slate-950/60 backdrop-blur-sm"
            onClick={() => {
              if (loading) {
                return;
              }
              closeCreateModal();
            }}
            aria-label="Close add company modal"
          />
          <div className="relative z-10 w-full max-w-lg rounded-3xl border border-slate-200 bg-white p-6 shadow-2xl shadow-slate-900/30 dark:border-slate-700 dark:bg-slate-900">
            <div className="mb-4 flex items-center justify-between gap-3">
              <h3 className="text-lg font-semibold text-slate-900 dark:text-slate-100">Add company</h3>
              <button
                type="button"
                onClick={() => {
                  if (loading) {
                    return;
                  }
                  closeCreateModal();
                }}
                className="rounded-full border border-slate-300 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-slate-600 transition hover:border-slate-400 hover:text-slate-800 disabled:cursor-not-allowed disabled:opacity-60 dark:border-slate-600 dark:text-slate-300 dark:hover:border-slate-500 dark:hover:text-slate-100"
                disabled={loading}
              >
                Close
              </button>
            </div>
            <form onSubmit={handleCreate} className="space-y-5">
              <div className="space-y-3">
                <label className="flex flex-col gap-2 text-sm">
                  <span className="font-medium text-slate-700 dark:text-slate-200">Company name</span>
                  <input
                    value={createForm.name}
                    onChange={(event) => setCreateForm((prev) => ({ ...prev, name: event.target.value }))}
                    className="rounded-2xl border border-slate-300 bg-white/80 px-3 py-2 text-sm text-slate-900 shadow-inner transition focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-200 dark:border-slate-700 dark:bg-slate-900/60 dark:text-slate-100 dark:focus:border-blue-400 dark:focus:ring-blue-500/30"
                    placeholder="New company name"
                    required
                  />
                </label>

                <label className="flex flex-col gap-2 text-sm">
                  <span className="font-medium text-slate-700 dark:text-slate-200">Phone (optional)</span>
                  <input
                    value={createForm.phone}
                    onChange={(event) => setCreateForm((prev) => ({ ...prev, phone: event.target.value }))}
                    className="rounded-2xl border border-slate-300 bg-white/80 px-3 py-2 text-sm text-slate-900 shadow-inner transition focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-200 dark:border-slate-700 dark:bg-slate-900/60 dark:text-slate-100 dark:focus:border-blue-400 dark:focus:ring-blue-500/30"
                    placeholder="(555) 987-6543"
                  />
                </label>

                <label className="flex flex-col gap-2 text-sm">
                  <span className="font-medium text-slate-700 dark:text-slate-200">Business type</span>
                  <input
                    value={createForm.businessTypeName}
                    onChange={(event) => setCreateForm((prev) => ({ ...prev, businessTypeName: event.target.value }))}
                    className="rounded-2xl border border-slate-300 bg-white/80 px-3 py-2 text-sm text-slate-900 shadow-inner transition focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-200 dark:border-slate-700 dark:bg-slate-900/60 dark:text-slate-100 dark:focus:border-blue-400 dark:focus:ring-blue-500/30"
                    placeholder="Restaurant"
                  />
                </label>

                <label className="flex flex-col gap-2 text-sm">
                  <span className="font-medium text-slate-700 dark:text-slate-200">Primary jurisdiction</span>
                  <input
                    value={createForm.jurisdictionName}
                    onChange={(event) => setCreateForm((prev) => ({ ...prev, jurisdictionName: event.target.value }))}
                    className="rounded-2xl border border-slate-300 bg-white/80 px-3 py-2 text-sm text-slate-900 shadow-inner transition focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-200 dark:border-slate-700 dark:bg-slate-900/60 dark:text-slate-100 dark:focus:border-blue-400 dark:focus:ring-blue-500/30"
                    placeholder="City of Exampleville"
                  />
                </label>

                <label className="flex flex-col gap-2 text-sm">
                  <span className="font-medium text-slate-700 dark:text-slate-200">Notes</span>
                  <textarea
                    value={createForm.notes}
                    onChange={(event) => setCreateForm((prev) => ({ ...prev, notes: event.target.value }))}
                    rows={4}
                    className="rounded-2xl border border-slate-300 bg-white/80 px-3 py-2 text-sm text-slate-900 shadow-inner transition focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-200 dark:border-slate-700 dark:bg-slate-900/60 dark:text-slate-100 dark:focus:border-blue-400 dark:focus:ring-blue-500/30"
                    placeholder="Internal notes for this company"
                  />
                </label>
              </div>

              <div className="flex flex-wrap gap-3">
                <button
                  type="submit"
                  disabled={loading}
                  className="inline-flex items-center justify-center rounded-full bg-gradient-to-r from-emerald-500 to-emerald-600 px-5 py-2 text-sm font-semibold text-white shadow-md shadow-emerald-500/20 transition hover:from-emerald-400 hover:to-emerald-500 disabled:cursor-wait disabled:opacity-60"
                >
                  {loading ? "Adding…" : "Add company"}
                </button>

                <button
                  type="button"
                  onClick={() => closeCreateModal()}
                  disabled={loading}
                  className="inline-flex items-center justify-center rounded-full border border-slate-300 px-5 py-2 text-sm font-semibold text-slate-600 transition hover:border-slate-400 hover:text-slate-800 disabled:cursor-not-allowed disabled:opacity-60 dark:border-slate-700 dark:text-slate-300 dark:hover:border-slate-500 dark:hover:text-slate-100"
                >
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {isPermitPreviewOpen && permitFilePreview && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <button
            type="button"
            className="absolute inset-0 bg-slate-950/70 backdrop-blur-sm"
            onClick={() => setIsPermitPreviewOpen(false)}
            aria-label="Close permit preview"
          />
          <div className="relative z-10 max-h-[90vh] w-[90vw] max-w-4xl rounded-3xl border border-slate-200 bg-white p-4 shadow-2xl shadow-slate-900/40 dark:border-slate-700 dark:bg-slate-900">
            <div className="mb-4 flex items-center justify-between gap-3">
              <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200">{permitPreviewTitle}</h3>
              <button
                type="button"
                onClick={() => setIsPermitPreviewOpen(false)}
                className="rounded-full border border-slate-300 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-slate-600 transition hover:border-slate-400 hover:text-slate-800 dark:border-slate-600 dark:text-slate-300 dark:hover:border-slate-500 dark:hover:text-slate-100"
              >
                Close
              </button>
            </div>
            <div className="flex max-h-[75vh] w-full items-center justify-center overflow-hidden rounded-2xl border border-slate-200 bg-slate-50 dark:border-slate-700 dark:bg-slate-900">
              {isImagePreview ? (
                <div className="relative h-[75vh] w-full">
                  <Image
                    src={permitFilePreview}
                    alt="Permit preview"
                    fill
                    className="object-contain"
                    unoptimized
                  />
                </div>
              ) : isPdfPreview ? (
                <iframe
                  src={permitFilePreview}
                  title="Permit PDF preview"
                  className="h-[75vh] w-full"
                />
              ) : (
                <div className="p-6 text-sm text-slate-600 dark:text-slate-300">
                  Preview not available for this file type.
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
