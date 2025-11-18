"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

function resolveErrorMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return fallback;
}

type Profile = {
  id: string;
  email: string | null;
  name: string | null;
  phone: string | null;
};

export default function SettingsPage() {
  const router = useRouter();
  const supabase = useMemo(() => createSupabaseBrowserClient(), []);

  const [profile, setProfile] = useState<Profile | null>(null);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [loading, setLoading] = useState(false);
  const [isFetching, setIsFetching] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    async function loadProfile() {
      setIsFetching(true);
      setError(null);

      const {
        data: { session },
      } = await supabase.auth.getSession();

      if (!session) {
        router.replace("/login");
        return;
      }

      try {
        const response = await fetch("/api/profile", { cache: "no-store" });

        if (response.status === 401) {
          router.replace("/login");
          return;
        }

        if (!response.ok) {
          const payload = await response.json().catch(() => ({}));
          throw new Error(payload.error || "Failed to load profile");
        }

        const data = (await response.json()) as Profile;

        if (!active) {
          return;
        }

        setProfile(data);
        setName(data.name ?? "");
        setPhone(data.phone ?? "");
      } catch (err: unknown) {
        if (!active) {
          return;
        }
        setError(resolveErrorMessage(err, "Failed to load profile"));
      } finally {
        if (active) {
          setIsFetching(false);
        }
      }
    }

    loadProfile();

    return () => {
      active = false;
    };
  }, [router, supabase]);

  async function handleUpdate(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setSuccessMessage(null);

    if (!name.trim()) {
      setError("Name is required");
      return;
    }

    setLoading(true);

    try {
      const response = await fetch("/api/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          phone: phone.trim(),
        }),
      });

      const payload = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(payload.error || "Failed to update profile");
      }

      const updated = payload as Profile;
      setProfile(updated);
      setSuccessMessage("Profile updated successfully");
    } catch (err: unknown) {
      setError(resolveErrorMessage(err, "Failed to update profile"));
    } finally {
      setLoading(false);
    }
  }

  async function handleSignOut() {
    await supabase.auth.signOut();
    router.replace("/login");
  }

  return (
    <main className="min-h-screen bg-gradient-to-b from-slate-50 via-white to-white px-4 py-12 text-slate-900 transition-colors duration-300 dark:from-slate-950 dark:via-slate-900 dark:to-slate-950 dark:text-slate-100">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-8">
        <header className="rounded-3xl border border-slate-200/60 bg-white/80 px-6 py-8 shadow-lg shadow-slate-200/50 backdrop-blur dark:border-slate-800/60 dark:bg-slate-900/60 dark:shadow-black/40 sm:px-10 sm:py-12">
          <div className="flex flex-col gap-3">
            <span className="text-xs font-semibold uppercase tracking-[0.4em] text-slate-400 dark:text-slate-500">
              Account
            </span>
            <h1 className="text-3xl font-semibold sm:text-4xl">Profile settings</h1>
            <p className="text-sm text-slate-600 dark:text-slate-400">
              Update your contact details and manage your session.
            </p>
            <Link
              href="/dashboard"
              className="text-xs font-semibold uppercase tracking-wide text-blue-600 underline-offset-4 hover:underline dark:text-blue-400"
            >
              ← Back to dashboard
            </Link>
          </div>
        </header>

        <section className="rounded-3xl border border-slate-200/60 bg-white/80 p-6 shadow-2xl shadow-slate-200/60 backdrop-blur dark:border-slate-800/60 dark:bg-slate-900/60 dark:shadow-black/40 sm:p-10">
          {error && (
            <div className="mb-4 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-800/60 dark:bg-red-950/40 dark:text-red-300">
              {error}
            </div>
          )}

          {successMessage && (
            <div className="mb-4 rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-700 dark:border-emerald-600/40 dark:bg-emerald-900/20 dark:text-emerald-200">
              {successMessage}
            </div>
          )}

          {isFetching ? (
            <div className="rounded-2xl border border-dashed border-slate-300 bg-white/70 p-6 text-sm text-slate-500 dark:border-slate-700 dark:bg-slate-900/40 dark:text-slate-400">
              Loading profile…
            </div>
          ) : (
            <form onSubmit={handleUpdate} className="space-y-5">
              <div className="space-y-3">
                <label className="flex flex-col gap-2 text-sm">
                  <span className="font-medium text-slate-700 dark:text-slate-200">Full name</span>
                  <input
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    className="rounded-2xl border border-slate-300 bg-white/80 px-3 py-2 text-sm text-slate-900 shadow-inner transition focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-200 dark:border-slate-700 dark:bg-slate-900/60 dark:text-slate-100 dark:focus:border-blue-400 dark:focus:ring-blue-500/30"
                    placeholder="Ada Lovelace"
                    required
                  />
                </label>

                <label className="flex flex-col gap-2 text-sm">
                  <span className="font-medium text-slate-700 dark:text-slate-200">Email</span>
                  <input
                    value={profile?.email ?? ""}
                    disabled
                    className="rounded-2xl border border-slate-200 bg-white/70 px-3 py-2 text-sm text-slate-500 shadow-inner dark:border-slate-800 dark:bg-slate-900/40 dark:text-slate-400"
                    placeholder="you@example.com"
                  />
                  <span className="text-xs text-slate-500 dark:text-slate-400">
                    Email changes are managed through Supabase Auth settings.
                  </span>
                </label>

                <label className="flex flex-col gap-2 text-sm">
                  <span className="font-medium text-slate-700 dark:text-slate-200">Phone</span>
                  <input
                    value={phone}
                    onChange={(event) => setPhone(event.target.value)}
                    className="rounded-2xl border border-slate-300 bg-white/80 px-3 py-2 text-sm text-slate-900 shadow-inner transition focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-200 dark:border-slate-700 dark:bg-slate-900/60 dark:text-slate-100 dark:focus:border-blue-400 dark:focus:ring-blue-500/30"
                    placeholder="(555) 123-4567"
                  />
                </label>
              </div>

              <div className="flex flex-wrap gap-3">
                <button
                  type="submit"
                  disabled={loading}
                  className="inline-flex items-center justify-center rounded-full bg-gradient-to-r from-blue-600 to-indigo-600 px-5 py-2 text-sm font-semibold text-white shadow-lg shadow-blue-600/30 transition hover:from-blue-500 hover:to-indigo-500 disabled:cursor-wait disabled:opacity-60"
                >
                  {loading ? "Saving…" : "Save changes"}
                </button>
                <button
                  type="button"
                  onClick={handleSignOut}
                  className="inline-flex items-center justify-center rounded-full border border-red-300 px-5 py-2 text-sm font-semibold text-red-600 transition hover:border-red-400 hover:text-red-700 dark:border-red-700 dark:text-red-300 dark:hover:border-red-500 dark:hover:text-red-200"
                >
                  Sign out
                </button>
              </div>
            </form>
          )}
        </section>
      </div>
    </main>
  );
}
