import { prisma } from "../lib/prisma";
import { urlLang, type Lang } from "../lib/linkGuard";

export type LinkCandidate = { title: string; url: string; score: number; isOrphan?: boolean };

const STOP = new Set(
  (
    "the and for with from that this your you are our best tips guide how what when where why into about " +
    "more most very can will have has was were not but all any one two out new top ultimate complete " +
    "des les une pour dans avec sur par aux est sont qui que quoi plus tres " +
    "para com uma uns umas dos das nos nas por que mais como pelo pela"
  ).split(" "),
);

function words(s: string) {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3 && !STOP.has(w));
}

function bigrams(ws: string[]) {
  const out: string[] = [];
  for (let i = 0; i < ws.length - 1; i++) out.push(`${ws[i]} ${ws[i + 1]}`);
  return out;
}

/**
 * Hybrid-lite relevance ranking: keyword/title overlap between the new
 * content's title+keywords and every existing SitePage / published
 * ContentItem on the site. (Structured relational scoring now; can be
 * swapped for embedding cosine-similarity later without changing callers —
 * see TASKS.md note.)
 */
export async function rankLinkTargets(
  siteId: string,
  title: string,
  keywords: string[] = [],
  // minResults is kept for API compatibility but no longer pads with unrelated pages:
  // a link that is not topically relevant is worse than fewer links.
  opts: { limit?: number; excludeContentId?: string; language?: Lang; minResults?: number } = {}
): Promise<LinkCandidate[]> {
  const limit = opts.limit ?? 15;

  const [pages, content] = await Promise.all([
    prisma.sitePage.findMany({
      where: { siteId },
      select: { title: true, url: true, isOrphan: true, summary: true },
    }),
    prisma.contentItem.findMany({
      where: {
        siteId,
        status: "PUBLISHED",
        ...(opts.language ? { language: opts.language } : {}),
        ...(opts.excludeContentId ? { id: { not: opts.excludeContentId } } : {}),
      },
      select: { title: true, wpUrl: true, focusKeyword: true },
    }),
  ]);

  type Doc = { title: string; url: string; isOrphan?: boolean; tokens: string[] };
  const docs: Doc[] = [];
  for (const p of pages) {
    if (opts.language && urlLang(p.url) !== opts.language) continue;
    docs.push({
      title: p.title,
      url: p.url,
      isOrphan: p.isOrphan,
      tokens: words(`${p.title} ${p.title} ${p.summary ?? ""}`),
    });
  }
  for (const c of content) {
    if (!c.wpUrl) continue;
    docs.push({
      title: c.title,
      url: c.wpUrl,
      tokens: words(`${c.title} ${c.title} ${c.focusKeyword ?? ""}`),
    });
  }
  if (docs.length === 0) return [];

  // IDF over the site's own pages: words every page shares ("lisbon", "boat")
  // carry almost no weight, topic-specific words ("corporate", "wedding") carry a lot.
  const df = new Map<string, number>();
  for (const d of docs) for (const t of new Set(d.tokens)) df.set(t, (df.get(t) ?? 0) + 1);
  const N = docs.length;
  const idf = (t: string) => Math.max(0, Math.log((N + 1) / ((df.get(t) ?? 0) + 1)));

  const titleWords = words(title);
  const kwWords = keywords.flatMap(words);
  const targetWeight = new Map<string, number>();
  for (const t of titleWords) targetWeight.set(t, Math.max(targetWeight.get(t) ?? 0, 1));
  for (const t of kwWords) targetWeight.set(t, Math.max(targetWeight.get(t) ?? 0, 1.5));
  const targetBigrams = new Set([...bigrams(titleWords), ...keywords.flatMap((k) => bigrams(words(k)))]);

  const scored: LinkCandidate[] = [];
  for (const d of docs) {
    let score = 0;
    for (const t of new Set(d.tokens)) {
      const w = targetWeight.get(t);
      if (w) score += idf(t) * w;
    }
    for (const b of new Set(bigrams(d.tokens))) if (targetBigrams.has(b)) score += 2;
    if (score > 0) scored.push({ title: d.title, url: d.url, score, isOrphan: d.isOrphan });
  }

  scored.sort((a, b) => b.score - a.score);
  const top = scored[0]?.score ?? 0;
  // Keep only genuinely related pages: a meaningful absolute score AND close to the best match.
  const MIN_ABS = 1.5;
  const relevant = scored.filter((c) => c.score >= MIN_ABS && c.score >= top * 0.4);

  // Small nudge for orphan pages among the already-relevant ones.
  for (const c of relevant) if (c.isOrphan) c.score += 0.5;
  return relevant.sort((a, b) => b.score - a.score).slice(0, limit);
}

/** Records which links were actually inserted into a piece of content — builds the explicit relationship graph the brief asks for. */
export async function recordAppliedLinks(
  siteId: string,
  sourceType: "content" | "page",
  sourceId: string,
  bodyHtml: string
) {
  const hrefRe = /<a\s[^>]*href=["']([^"']+)["'][^>]*>(.*?)<\/a>/gi;
  const rows: Array<{ url: string; anchor: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = hrefRe.exec(bodyHtml))) {
    rows.push({ url: m[1], anchor: m[2].replace(/<[^>]+>/g, "").trim() });
  }
  if (!rows.length) return 0;

  await prisma.pageLink.deleteMany({ where: { siteId, sourceId } });
  await prisma.pageLink.createMany({
    data: rows.map((r) => ({
      siteId,
      sourceType,
      sourceId,
      targetUrl: r.url,
      anchorText: r.anchor || null,
    })),
  });
  return rows.length;
}
