// NCBI PubMed retrieval via E-utilities (esearch + efetch), a faithful port of
// the Python pubmed.py. BioPython's Entrez/Medline are replaced by direct REST
// calls with `fetch`; MEDLINE text is parsed inline.
//
// Config via env (server-only):
//   NCBI_EMAIL    recommended — NCBI asks callers to identify themselves; absent
//                 is tolerated but you may be throttled sooner.
//   NCBI_API_KEY  optional — raises the rate limit from 3/sec to 10/sec.

import type { PubMedArticle } from "./types";

const EUTILS = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";

// Retry tuning for transient NCBI failures (HTTP 429, 5xx, network/timeout).
// Backoff before retry N is BASE_DELAY_MS * 2**(N-1): ~1s, 2s, 4s.
const MAX_ATTEMPTS = 4;
const BASE_DELAY_MS = 1000;

/** An NCBI call kept failing transiently after all retries. */
export class PubMedRateLimitError extends Error {}

/** Non-retryable failure (malformed request, other 4xx) — fail fast. */
class FatalHttpError extends Error {}
/** Retryable failure (429/5xx). Network errors from fetch are retryable too. */
class TransientHttpError extends Error {}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function isTransientStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600);
}

function eutilsUrl(endpoint: string, params: Record<string, string>): string {
  const p = new URLSearchParams(params);
  p.set("tool", "ace-stage1");
  const email = process.env.NCBI_EMAIL;
  if (email) p.set("email", email);
  const apiKey = process.env.NCBI_API_KEY;
  if (apiKey) p.set("api_key", apiKey);
  return `${EUTILS}/${endpoint}?${p.toString()}`;
}

/**
 * Run an E-utilities thunk, retrying transient failures with exponential
 * backoff. Fatal errors (malformed query, other 4xx) propagate immediately.
 * Exhausted retries raise PubMedRateLimitError.
 */
async function withRetries<T>(what: string, fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof FatalHttpError) throw err;
      // TransientHttpError or a network-level fetch failure → retry.
      lastErr = err;
      if (attempt === MAX_ATTEMPTS) break;
      await sleep(BASE_DELAY_MS * 2 ** (attempt - 1));
    }
  }
  throw new PubMedRateLimitError(
    `NCBI E-utilities ${what} failed after ${MAX_ATTEMPTS} attempts: ${
      lastErr instanceof Error ? lastErr.message : String(lastErr)
    }`
  );
}

async function fetchOrThrow(url: string, what: string): Promise<Response> {
  const res = await fetch(url);
  if (!res.ok) {
    if (isTransientStatus(res.status)) {
      throw new TransientHttpError(`${what} HTTP ${res.status}`);
    }
    throw new FatalHttpError(`${what} HTTP ${res.status}`);
  }
  return res;
}

/**
 * Parse MEDLINE text into articles. MEDLINE fields are `TAG - value` with the
 * tag left-justified in columns 0-3 and continuation lines indented six spaces;
 * records are separated by a blank line.
 */
export function parseMedline(text: string): PubMedArticle[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const articles: PubMedArticle[] = [];
  let fields: Record<string, string[]> = {};
  let lastKey: string | null = null;

  const flush = () => {
    if (Object.keys(fields).length > 0) {
      articles.push(recordToArticle(fields));
      fields = {};
      lastKey = null;
    }
  };

  for (const line of lines) {
    if (line.trim() === "") {
      flush();
      continue;
    }
    if (/^.{4}- /.test(line)) {
      const key = line.slice(0, 4).trim();
      const value = line.slice(6);
      (fields[key] ??= []).push(value);
      lastKey = key;
    } else if (lastKey && /^\s{6}/.test(line)) {
      const arr = fields[lastKey];
      arr[arr.length - 1] += " " + line.trim();
    }
  }
  flush();
  return articles;
}

function recordToArticle(f: Record<string, string[]>): PubMedArticle {
  const dp = f.DP?.[0] ?? "";
  const year = /^\d{4}/.test(dp) ? parseInt(dp.slice(0, 4), 10) : null;
  const abstract = f.AB ? f.AB.join(" ").trim() : "";
  return {
    pmid: (f.PMID?.[0] ?? "").trim(),
    title: (f.TI ?? []).join(" ").trim(),
    abstract: abstract || null,
    year,
    journal: f.TA?.[0]?.trim() || null,
    authors: f.AU ?? [],
  };
}

/**
 * Search PubMed and return parsed articles, most-relevant first. esearch gets
 * the PMID list, efetch pulls the MEDLINE records.
 */
export async function searchPubmed(
  query: string,
  maxResults = 10
): Promise<PubMedArticle[]> {
  const pmids = await withRetries("esearch", async () => {
    const url = eutilsUrl("esearch.fcgi", {
      db: "pubmed",
      term: query,
      retmax: String(maxResults),
      sort: "relevance",
      retmode: "json",
    });
    const res = await fetchOrThrow(url, "esearch");
    const json = (await res.json()) as {
      esearchresult?: { idlist?: string[] };
    };
    return json.esearchresult?.idlist ?? [];
  });

  if (pmids.length === 0) return [];

  return withRetries("efetch", async () => {
    const url = eutilsUrl("efetch.fcgi", {
      db: "pubmed",
      id: pmids.join(","),
      rettype: "medline",
      retmode: "text",
    });
    const res = await fetchOrThrow(url, "efetch");
    return parseMedline(await res.text());
  });
}
