import type { Site } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { siteWpAuth } from "../lib/siteAuth";
import { listWpCategories, listWpPosts, listWpPostTypes } from "./wordpress";

function stripHtml(html?: string) {
  return (html ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

/** Pull every href from rendered content, normalized to bare path form. */
function extractLinkedUrls(html: string | undefined, siteBaseUrl: string): Set<string> {
  const found = new Set<string>();
  if (!html) return found;
  const hrefRe = /href=["']([^"']+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = hrefRe.exec(html))) {
    let href = m[1];
    try {
      const abs = new URL(href, siteBaseUrl).toString();
      if (abs.startsWith(siteBaseUrl.replace(/\/$/, ""))) {
        found.add(abs.replace(/\/$/, ""));
      }
    } catch {
      // ignore malformed hrefs
    }
  }
  return found;
}

function decodeEntities(s: string) {
  return s
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;|&apos;/g, "'");
}

/**
 * Mirror WordPress categories into the app: match by WP id first (so renames
 * and slug changes update the same row), then by slug; create new ones; drop
 * categories that no longer exist in WP (their posts become uncategorised).
 */
export async function syncCategories(
  site: Site,
  authIn?: Awaited<ReturnType<typeof siteWpAuth>>,
) {
  const auth = authIn ?? (await siteWpAuth(site));
  const wp = await listWpCategories(auth.baseUrl, auth.username, auth.appPassword);
  if (wp.length === 0) return { count: 0, removed: 0 }; // never prune on an empty answer

  const local = await prisma.category.findMany({ where: { siteId: site.id } });
  const byWp = new Map<number, (typeof local)[number]>();
  for (const c of local) if (c.wpCategoryId != null) byWp.set(c.wpCategoryId, c);
  const bySlug = new Map(local.map((c) => [c.slug, c]));

  for (const cat of wp) {
    const name = decodeEntities(cat.name);
    const existing = byWp.get(cat.id) ?? bySlug.get(cat.slug);
    try {
      if (existing) {
        await prisma.category.update({
          where: { id: existing.id },
          data: { name, slug: cat.slug, wpCategoryId: cat.id },
        });
      } else {
        await prisma.category.create({
          data: { siteId: site.id, wpCategoryId: cat.id, name, slug: cat.slug },
        });
      }
    } catch (err) {
      console.warn("[syncCategories] skipped", cat.slug, err instanceof Error ? err.message : err);
    }
  }

  const fresh = await prisma.category.findMany({ where: { siteId: site.id } });
  const freshByWp = new Map(fresh.filter((c) => c.wpCategoryId != null).map((c) => [c.wpCategoryId as number, c]));
  for (const cat of wp) {
    const child = freshByWp.get(cat.id);
    if (!child) continue;
    const parent = cat.parent ? freshByWp.get(cat.parent) : null;
    if ((child.parentId ?? null) !== (parent?.id ?? null)) {
      await prisma.category.update({ where: { id: child.id }, data: { parentId: parent?.id ?? null } });
    }
  }

  const wpIds = new Set(wp.map((c) => c.id));
  const stale = fresh.filter((c) => c.wpCategoryId != null && !wpIds.has(c.wpCategoryId));
  for (const c of stale) {
    await prisma.contentItem.updateMany({ where: { categoryId: c.id }, data: { categoryId: null } });
    await prisma.category.updateMany({ where: { parentId: c.id }, data: { parentId: null } });
    await prisma.category.delete({ where: { id: c.id } });
  }

  return { count: wp.length, removed: stale.length };
}

export type ScanResult = {
  categoriesIndexed: number;
  pagesIndexed: number;
  orphanCount: number;
  postTypesScanned: string[];
};

/**
 * Full site architecture import: categories (with hierarchy), posts, pages,
 * and any public custom post types — paginated so large sites are fully
 * indexed, not just the first 40 items. Then flags orphan pages: any
 * SitePage never linked to from any other page's content.
 */
export async function scanSite(site: Site): Promise<ScanResult> {
  const auth = await siteWpAuth(site);

  // --- Categories + hierarchy (also prunes ones removed in WP) ---
  const catSync = await syncCategories(site, auth);

  // --- Post types to scan: built-ins + discovered custom types ---
  let customTypes: string[] = [];
  try {
    customTypes = await listWpPostTypes(auth.baseUrl, auth.username, auth.appPassword);
  } catch {
    // non-fatal — older WP or restricted endpoint
  }
  const typesToScan = ["posts", "pages", ...customTypes];

  const allItems: Array<{ url: string; contentHtml: string }> = [];
  let pagesIndexed = 0;
  const now = new Date();

  for (const type of typesToScan) {
    let items;
    try {
      items = await listWpPosts(auth.baseUrl, auth.username, auth.appPassword, { type });
    } catch {
      continue; // type not accessible, skip
    }

    for (const item of items) {
      const url = item.link;
      if (!url) continue;
      const title = stripHtml(item.title?.rendered) || "Untitled";
      const summary = stripHtml(item.excerpt?.rendered).slice(0, 400) || null;
      const contentHtml = item.content?.rendered ?? "";

      await prisma.sitePage.upsert({
        where: { siteId_url: { siteId: site.id, url } },
        create: {
          siteId: site.id,
          wpPostId: item.id,
          title,
          url,
          summary,
          pageType: type === "pages" ? "page" : type === "posts" ? "post" : type,
          lastScannedAt: now,
        },
        update: {
          wpPostId: item.id,
          title,
          summary,
          pageType: type === "pages" ? "page" : type === "posts" ? "post" : type,
          lastScannedAt: now,
        },
      });

      allItems.push({ url: url.replace(/\/$/, ""), contentHtml });
      pagesIndexed += 1;
    }
  }

  // --- Orphan detection: union of every href across every page's content ---
  const linkedUrls = new Set<string>();
  for (const item of allItems) {
    const links = extractLinkedUrls(item.contentHtml, site.baseUrl);
    for (const url of links) linkedUrls.add(url);
  }

  const allSitePages = await prisma.sitePage.findMany({ where: { siteId: site.id } });
  let orphanCount = 0;
  for (const page of allSitePages) {
    const isOrphan = !linkedUrls.has(page.url.replace(/\/$/, ""));
    if (isOrphan) orphanCount += 1;
    if (page.isOrphan !== isOrphan) {
      await prisma.sitePage.update({ where: { id: page.id }, data: { isOrphan } });
    }
  }

  return {
    categoriesIndexed: catSync.count,
    pagesIndexed,
    orphanCount,
    postTypesScanned: typesToScan,
  };
}
