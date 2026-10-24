"use client";

import { useState } from "react";
import type { Step5ArtifactStatus, Step5XmlPackage } from "@/lib/common/query-plan-types";

const STATUS_PRESENTATION: Record<
  Step5ArtifactStatus,
  { label: string; tone: string }
> = {
  ready: {
    label: "Ready for Sharephe",
    tone: "border-emerald-200 bg-emerald-50 text-emerald-700",
  },
  needs_mapping: {
    label: "Needs mapping",
    tone: "border-red-200 bg-red-50 text-red-700",
  },
  needs_manual_review: {
    label: "Needs manual review",
    tone: "border-amber-200 bg-amber-50 text-amber-700",
  },
};

function asciiSlug(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[^\x00-\x7F]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/g, "");
}

function stableIdHash(value: string): string {
  let forward = 0x811c9dc5;
  let reverse = 0x9e3779b1;
  for (let index = 0; index < value.length; index += 1) {
    forward = Math.imul(forward ^ value.charCodeAt(index), 0x01000193);
    reverse = Math.imul(
      reverse ^ value.charCodeAt(value.length - index - 1),
      0x85ebca6b
    );
  }
  return `${(forward >>> 0).toString(16).padStart(8, "0")}${(reverse >>> 0)
    .toString(16)
    .padStart(8, "0")}`;
}

export function xmlDownloadFileName(queryName: string, queryId: string): string {
  const name = asciiSlug(queryName);
  const id = asciiSlug(queryId);
  if (!queryId) return `${name || "i2b2-query"}.xml`;

  const readableId = (id || "query").slice(0, 24).replace(/-+$/g, "");
  const identity = `${readableId || "query"}-${stableIdHash(queryId)}`;
  if (!name || name === id) return `${identity}.xml`;

  const nameBudget = Math.max(1, 120 - identity.length - 1);
  const boundedName = name.slice(0, nameBudget).replace(/-+$/g, "") || "q";
  return `${boundedName}-${identity}.xml`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

export function isStep5XmlPackage(value: unknown): value is Step5XmlPackage {
  if (!isRecord(value) || value.version !== "step5-i2b2-xml-v1") return false;
  if (typeof value.querySetName !== "string" || !Array.isArray(value.artifacts)) {
    return false;
  }
  if (
    !value.artifacts.every(
      (artifact) =>
        isRecord(artifact) &&
        typeof artifact.queryId === "string" &&
        typeof artifact.queryName === "string" &&
        (typeof artifact.xml === "string" || artifact.xml === null) &&
        (artifact.status === "ready" ||
          artifact.status === "needs_mapping" ||
          artifact.status === "needs_manual_review") &&
        typeof artifact.sharepheReady === "boolean" &&
        isStringArray(artifact.warnings) &&
        typeof artifact.panelSummary === "string"
    )
  ) {
    return false;
  }
  const summary = value.validationSummary;
  return (
    isRecord(summary) &&
    Number.isInteger(summary.readyCount) &&
    Number.isInteger(summary.needsMappingCount) &&
    Number.isInteger(summary.needsManualReviewCount) &&
    (summary.readyCount as number) >= 0 &&
    (summary.needsMappingCount as number) >= 0 &&
    (summary.needsManualReviewCount as number) >= 0 &&
    isStringArray(summary.warnings)
  );
}

export function Step5ResultDetails({
  data,
}: {
  data: unknown;
}): React.ReactNode {
  if (!isStep5XmlPackage(data)) {
    return (
      <div
        role="alert"
        className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900"
      >
        <p className="font-semibold">No XML package was emitted.</p>
        <p className="mt-1">
          Review the refreshed Step 4 plan, then run Step 5 again.
        </p>
      </div>
    );
  }
  return <I2b2XmlResults package={data} />;
}

export function I2b2XmlResults({
  package: xmlPackage,
}: {
  package: Step5XmlPackage;
}): React.ReactNode {
  const [feedback, setFeedback] = useState<{
    queryId: string;
    message: string;
    error: boolean;
  } | null>(null);

  async function copyXml(queryId: string, xml: string | null): Promise<void> {
    if (!xml || !navigator.clipboard) {
      setFeedback({
        queryId,
        message: "Clipboard access is unavailable.",
        error: true,
      });
      return;
    }

    try {
      await navigator.clipboard.writeText(xml);
      setFeedback({ queryId, message: "XML copied.", error: false });
    } catch {
      setFeedback({ queryId, message: "Copy failed.", error: true });
    }
  }

  function downloadXml(
    queryId: string,
    queryName: string,
    xml: string | null
  ): void {
    if (!xml) return;

    const blob = new Blob([xml], { type: "application/xml;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = xmlDownloadFileName(queryName, queryId);
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
  }

  return (
    <section aria-labelledby="step5-query-set" className="space-y-4">
      <div className="border-b border-gray-200 pb-4">
        <h5
          id="step5-query-set"
          className="break-words text-base font-semibold text-gray-900"
        >
          {xmlPackage.querySetName || "Untitled i2b2 query set"}
        </h5>
        <div className="mt-2 flex flex-wrap gap-2 text-xs font-semibold">
          <span className="rounded-md border border-emerald-200 bg-emerald-50 px-2 py-1 text-emerald-700">
            Ready {xmlPackage.validationSummary.readyCount}
          </span>
          <span className="rounded-md border border-red-200 bg-red-50 px-2 py-1 text-red-700">
            Needs mapping {xmlPackage.validationSummary.needsMappingCount}
          </span>
          <span className="rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-amber-700">
            Manual review {xmlPackage.validationSummary.needsManualReviewCount}
          </span>
        </div>
      </div>

      {xmlPackage.validationSummary.warnings.length > 0 ? (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          <p className="font-semibold">Package warnings</p>
          <ul className="mt-1 list-disc space-y-1 pl-5">
            {xmlPackage.validationSummary.warnings.map((warning, index) => (
              <li key={`${index}-${warning}`}>{warning}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {xmlPackage.artifacts.map((artifact) => {
        const presentation = STATUS_PRESENTATION[artifact.status];
        const actionsDisabled = artifact.xml === null;
        const artifactFeedback =
          feedback?.queryId === artifact.queryId ? feedback : null;

        return (
          <article
            key={artifact.queryId}
            className="rounded-lg border border-gray-200 bg-white"
          >
            <header className="flex flex-wrap items-start justify-between gap-3 border-b border-gray-200 px-4 py-3">
              <div className="min-w-0">
                <h6 className="break-words text-sm font-semibold text-gray-900">
                  {artifact.queryName}
                </h6>
                <p className="mt-1 break-all font-mono text-xs text-gray-500">
                  {artifact.queryId}
                </p>
              </div>
              <span
                className={`rounded-md border px-2 py-1 text-xs font-semibold ${presentation.tone}`}
              >
                {presentation.label}
              </span>
            </header>

            <div className="px-4 py-3">
              <p className="text-xs font-semibold uppercase text-gray-500">
                Panel summary
              </p>
              <p className="mt-1 whitespace-pre-wrap text-sm text-gray-800">
                {artifact.panelSummary}
              </p>
            </div>

            {artifact.warnings.length > 0 ? (
              <div className="border-t border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                <p className="font-semibold">Validation warnings</p>
                <ul className="mt-1 list-disc space-y-1 pl-5">
                  {artifact.warnings.map((warning, index) => (
                    <li key={`${index}-${warning}`}>{warning}</li>
                  ))}
                </ul>
              </div>
            ) : null}

            <div className="border-t border-gray-200 px-4 py-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs font-semibold uppercase text-gray-500">
                  i2b2 XML
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    disabled={actionsDisabled}
                    onClick={() => void copyXml(artifact.queryId, artifact.xml)}
                    className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500/30 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Copy XML
                  </button>
                  <button
                    type="button"
                    disabled={actionsDisabled}
                    onClick={() =>
                      downloadXml(
                        artifact.queryId,
                        artifact.queryName,
                        artifact.xml
                      )
                    }
                    className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500/30 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Download XML
                  </button>
                </div>
              </div>

              {artifactFeedback ? (
                <p
                  aria-live="polite"
                  className={`mt-2 text-xs ${
                    artifactFeedback.error ? "text-red-700" : "text-emerald-700"
                  }`}
                >
                  {artifactFeedback.message}
                </p>
              ) : null}

              {artifact.xml ? (
                <pre className="mt-3 max-h-96 overflow-auto whitespace-pre rounded-lg border border-gray-200 bg-gray-50 p-3 font-mono text-xs text-gray-800">
                  {artifact.xml}
                </pre>
              ) : (
                <p className="mt-3 text-sm text-gray-600">
                  XML was not emitted for this query. Resolve its validation
                  warnings before Sharephe handoff.
                </p>
              )}
            </div>
          </article>
        );
      })}
    </section>
  );
}
