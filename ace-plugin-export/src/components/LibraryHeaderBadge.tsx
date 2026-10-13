// Small "📚 library: N saved" pill that scrolls to the SavedSetsLibrary
// section when clicked. Lives in each /step3* page's header for discoverability.

"use client";

import { useSets } from "@/lib/selection/useSelection";

export function LibraryHeaderBadge() {
  const { sets, mounted } = useSets();
  if (!mounted) return null;

  return (
    <button
      type="button"
      onClick={() => {
        const el = document.getElementById("concept-set-library");
        if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
      }}
      className="inline-flex items-center gap-1.5 rounded-full bg-emerald-100 px-3 py-1 text-xs font-medium text-emerald-800 ring-1 ring-emerald-300 hover:bg-emerald-200"
      title="jump to the saved-sets library"
    >
      <svg
        className="h-3.5 w-3.5"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        viewBox="0 0 24 24"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253"
        />
      </svg>
      library: {sets.length} saved
    </button>
  );
}
