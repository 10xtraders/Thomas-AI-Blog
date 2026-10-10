/**
 * Link guard: keeps competitor / unwanted outbound links out of generated posts.
 *
 * Configured per site through the existing "business facts" editor (Sites page):
 *   blocked_domains: competitor1.com, competitor2.com
 *   external_links: none        (optional — strips ALL outbound links)
 */

export type LinkPolicy = {
  siteHost: string;
  blocked: string[];
  allowExternal: boolean;
};

export const LINK_POLICY_FACT_KEYS = ["blocked_domains", "competitors", "external_links", "h1_in_content"];

const norm = (h: string) => h.toLowerCase().trim().replace(/^www\./, "");

function toHost(raw: string): string | null {
  const v = raw.trim();
  if (!v) return null;
  try {
    return norm(new URL(/^[a-z]+:\/\//i.test(v) ? v : `https://${v}`).hostname);
  } catch {
    return null;
  }
}

function hostMatches(host: string, domain: string) {
  return host === domain || host.endsWith(`.${domain}`);
}

export function buildLinkPolicy(
  baseUrl: string,
  facts: Array<{ key: string; value: string }>,
): LinkPolicy {
  const blocked: string[] = [];
  let allowExternal = true;

  for (const f of facts) {
    const key = f.key.trim().toLowerCase();
    if (key === "blocked_domains" || key === "competitors") {
      for (const part of f.value.split(/[,\s;]+/)) {
        const h = toHost(part);
        if (h) blocked.push(h);
      }
    }
    if (key === "external_links" && /^(none|no|off|false)$/i.test(f.value.trim())) {
      allowExternal = false;
    }
  }

  return {
    siteHost: toHost(baseUrl) ?? "",
    blocked: Array.from(new Set(blocked)),
    allowExternal,
  };
}

/** Drop research sources that point at blocked domains. */
export function filterSources<T extends { url: string }>(
  sources: T[],
  policy: LinkPolicy,
): T[] {
  return sources.filter((s) => {
    const h = toHost(s.url);
    return !h || !policy.blocked.some((d) => hostMatches(h, d));
  });
}

/**
 * Remove <a> tags that point to blocked domains (or to any external domain when
 * external_links is "none"). The anchor text is kept, only the link goes away.
 */
export function stripDisallowedLinks(
  html: string,
  policy: LinkPolicy,
): { html: string; removed: string[] } {
  const removed: string[] = [];
  const out = html.replace(
    /<a\b[^>]*?\shref\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi,
    (full, _q: string, href: string, inner: string) => {
      const h = href.trim();
      if (!h || h.startsWith("#") || h.startsWith("/") || /^(mailto|tel):/i.test(h)) {
        return full;
      }
      const host = toHost(h);
      if (!host) return full;
      if (policy.siteHost && hostMatches(host, policy.siteHost)) return full;

      const isBlocked = policy.blocked.some((d) => hostMatches(host, d));
      if (isBlocked || !policy.allowExternal) {
        removed.push(h);
        return inner;
      }
      return full;
    },
  );
  return { html: out, removed };
}

/* ------------------------------------------------------------------ */
/* Language-aware internal links + minimum internal link count         */
/* ------------------------------------------------------------------ */

export type Lang = "en" | "pt" | "fr";

/**
 * Language of a URL from its path prefix (/fr/..., /pt/..., /pt-pt/...).
 * No prefix = default language (en). Works for Polylang / WPML / TranslatePress
 * "directory" setups.
 */
export function urlLang(url: string): Lang {
  try {
    const p = new URL(url, "https://x.invalid").pathname.toLowerCase();
    const m = p.match(/^\/(fr|pt|en)(?:[-_][a-z]{2})?(?:\/|$)/);
    return (m?.[1] as Lang) ?? "en";
  } catch {
    return "en";
  }
}

function isInternal(href: string, siteHost: string) {
  const h = href.trim();
  if (!h || h.startsWith("#") || /^(mailto|tel):/i.test(h)) return false;
  if (h.startsWith("/")) return true;
  const host = toHost(h);
  return !!host && !!siteHost && hostMatches(host, siteHost);
}

const A_TAG = /<a\b[^>]*?\shref\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi;

const normUrl = (u: string) => u.trim().replace(/\/+$/, "").toLowerCase();

/** Swap hrefs using a map (e.g. English post URL -> its French translation URL). */
export function rewriteLinks(html: string, map: Map<string, string>) {
  if (!map.size) return html;
  return html.replace(A_TAG, (full, q: string, href: string) => {
    const to = map.get(normUrl(href));
    return to ? full.replace(`${q}${href}${q}`, `${q}${to}${q}`) : full;
  });
}

/** Unlink internal links that point at a page in a different language. */
export function stripWrongLanguageLinks(html: string, siteHost: string, lang: Lang) {
  const removed: string[] = [];
  const out = html.replace(A_TAG, (full, _q: string, href: string, inner: string) => {
    if (!isInternal(href, siteHost)) return full;
    if (urlLang(href) === lang) return full;
    removed.push(href);
    return inner;
  });
  return { html: out, removed };
}

const RELATED_HEADING: Record<Lang, string> = {
  en: "Related reading",
  fr: "À lire aussi",
  pt: "Leia também",
};

/** Guarantee at least `min` internal links by appending a short related-reading list. */
export function ensureInternalLinks(
  html: string,
  targets: Array<{ title: string; url: string }>,
  min: number,
  lang: Lang,
  siteHost: string,
) {
  const present = new Set<string>();
  let count = 0;
  html.replace(A_TAG, (full, _q: string, href: string) => {
    if (isInternal(href, siteHost)) {
      count++;
      present.add(normUrl(href));
    }
    return full;
  });
  if (count >= min) return { html, added: 0 };

  const extra = targets
    .filter((t) => !present.has(normUrl(t.url)) && urlLang(t.url) === lang)
    .slice(0, min - count);
  if (!extra.length) return { html, added: 0 };

  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const list = extra
    .map((t) => `<li><a href="${t.url}">${esc(t.title)}</a></li>`)
    .join("");
  return {
    html: `${html}\n<h2>${RELATED_HEADING[lang]}</h2>\n<ul>${list}</ul>`,
    added: extra.length,
  };
}
