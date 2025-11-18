"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

type ThemeMode = "light" | "dark" | "system";

const featureHighlights = [
  {
    title: "Upload with confidence",
    description:
      "Drop in permits or licenses and let Permit Buddy take care of the parsing and clean-up for you.",
  },
  {
    title: "Review before you save",
    description:
      "Confirm key fields, adjust dates, and make sure every document lands in your archive the right way.",
  },
  {
    title: "Stay renewal-ready",
    description:
      "Track expiration dates and statuses so renewals never sneak up on the team again.",
  },
];

const themeOptions: Array<{ value: ThemeMode; label: string }> = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "Auto" },
];

export default function LandingPage() {
  const [mode, setMode] = useState<ThemeMode>("system");
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    try {
      const stored = localStorage.getItem("permit-buddy-theme");
      if (stored === "light" || stored === "dark" || stored === "system") {
        setMode(stored);
      }
    } catch {
      // ignore read failures (e.g., storage disabled)
    } finally {
      setIsReady(true);
    }
  }, []);

  useEffect(() => {
    if (!isReady) {
      return;
    }

    const root = document.documentElement;
    const media = window.matchMedia("(prefers-color-scheme: dark)");

    const applyTheme = (value: ThemeMode) => {
      if (value === "dark") {
        root.classList.add("dark");
      } else if (value === "light") {
        root.classList.remove("dark");
      } else {
        root.classList.toggle("dark", media.matches);
      }
    };

    applyTheme(mode);

    try {
      localStorage.setItem("permit-buddy-theme", mode);
    } catch {
      // ignore write failures (e.g., private browsing)
    }

    if (mode !== "system") {
      return;
    }

    const handleChange = (event: MediaQueryListEvent) => {
      root.classList.toggle("dark", event.matches);
    };

    if (typeof media.addEventListener === "function") {
      media.addEventListener("change", handleChange);
      return () => media.removeEventListener("change", handleChange);
    }

    media.addListener(handleChange);
    return () => media.removeListener(handleChange);
  }, [mode, isReady]);

  return (
    <main className="min-h-screen bg-gradient-to-b from-slate-50 via-white to-white text-slate-900 dark:from-slate-950 dark:via-slate-900 dark:to-slate-950 dark:text-slate-100">
      <div className="mx-auto flex min-h-screen w-full max-w-6xl flex-col px-4 pb-20 pt-24 sm:px-8">
        <div className="mb-12 flex justify-end sm:mb-16">
          <div className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-white/80 p-1 text-xs font-medium shadow-sm backdrop-blur dark:border-slate-700 dark:bg-slate-900/70">
            {themeOptions.map((option) => {
              const isActive = option.value === mode;

              return (
                <button
                  key={option.value}
                  type="button"
                  aria-pressed={isActive}
                  onClick={() => setMode(option.value)}
                  className={`rounded-full px-3 py-1 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-offset-slate-900 ${
                    isActive
                      ? "bg-slate-900 text-white shadow-sm dark:bg-slate-100 dark:text-slate-900"
                      : "text-slate-600 hover:text-slate-900 dark:text-slate-300 dark:hover:text-slate-100"
                  }`}
                >
                  {option.label}
                </button>
              );
            })}
          </div>
        </div>

        <header className="text-center">
          <span className="inline-flex items-center justify-center gap-2 rounded-full border border-slate-200 bg-white/80 px-3 py-1 text-xs font-semibold uppercase tracking-widest text-slate-500 shadow-sm backdrop-blur dark:border-slate-800 dark:bg-slate-900/70 dark:text-slate-300">
            Permit Buddy
          </span>
          <h1 className="mt-6 text-4xl font-semibold tracking-tight sm:text-5xl">
            Keep business permits organized without the spreadsheet chaos
          </h1>
          <p className="mt-4 text-base text-slate-600 dark:text-slate-400 sm:text-lg">
            Upload a document, verify the details, and save it to a centralized compliance hub. No more
            chasing down PDF attachments when renewal season hits.
          </p>
          <div className="mt-8 flex flex-wrap justify-center gap-3">
            <Link
              href="/register"
              className="rounded-full bg-blue-600 px-5 py-3 text-sm font-semibold text-white shadow-lg shadow-blue-600/30 transition hover:bg-blue-500 focus:outline-none focus:ring-4 focus:ring-blue-500/30"
            >
              Create your account
            </Link>
            <Link
              href="/login"
              className="rounded-full border border-slate-300 px-5 py-3 text-sm font-semibold text-slate-700 transition hover:border-slate-400 hover:text-slate-900 dark:border-slate-700 dark:text-slate-300 dark:hover:border-slate-500 dark:hover:text-slate-100"
            >
              Sign in
            </Link>
          </div>
        </header>

        <section className="mt-20 grid gap-10 sm:grid-cols-2 lg:grid-cols-3">
          {featureHighlights.map((feature) => (
            <article
              key={feature.title}
              className="rounded-3xl border border-white/70 bg-white/80 p-6 shadow-xl shadow-slate-200/40 backdrop-blur-sm dark:border-slate-800/70 dark:bg-slate-900/60 dark:shadow-black/40"
            >
              <h3 className="text-lg font-semibold text-slate-800 dark:text-slate-100">
                {feature.title}
              </h3>
              <p className="mt-3 text-sm text-slate-600 dark:text-slate-400">{feature.description}</p>
            </article>
          ))}
        </section>

        <section className="mt-24 flex flex-col gap-6 rounded-3xl border border-slate-200/60 bg-white/80 p-8 shadow-2xl shadow-slate-200/50 backdrop-blur dark:border-slate-800/60 dark:bg-slate-900/60 dark:shadow-black/30 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-2xl font-semibold text-slate-800 dark:text-slate-100">
              Ready to see it in action?
            </h2>
            <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">
              Upload a document and walk through the confirmation flow in minutes.
            </p>
          </div>
          <div className="flex flex-wrap gap-3">
            <Link
              href="/register"
              className="rounded-full bg-emerald-500 px-5 py-3 text-sm font-semibold text-white shadow-lg shadow-emerald-500/30 transition hover:bg-emerald-400 focus:outline-none focus:ring-4 focus:ring-emerald-500/30"
            >
              Get started
            </Link>
            <Link
              href="/login"
              className="rounded-full border border-slate-300 px-5 py-3 text-sm font-semibold text-slate-700 transition hover:border-slate-400 hover:text-slate-900 dark:border-slate-700 dark:text-slate-300 dark:hover:border-slate-500 dark:hover:text-slate-100"
            >
              I already have an account
            </Link>
          </div>
        </section>
      </div>
    </main>
  );
}
