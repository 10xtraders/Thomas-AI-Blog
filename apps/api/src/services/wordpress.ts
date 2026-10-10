/** WordPress REST helpers — Application Password = Basic auth */

function basicAuth(username: string, appPassword: string) {
  const token = Buffer.from(`${username}:${appPassword}`).toString("base64");
  return `Basic ${token}`;
}

export async function wpFetch(
  baseUrl: string,
  username: string,
  appPassword: string,
  path: string,
  init?: RequestInit
) {
  const url = `${baseUrl.replace(/\/$/, "")}/wp-json${path}`;
  const headers: Record<string, string> = {
    Authorization: basicAuth(username, appPassword),
    ...(init?.headers as Record<string, string> | undefined),
  };
  if (!(init?.body instanceof FormData) && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }

  const res = await fetch(url, { ...init, headers });

  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  if (!res.ok) {
    throw new Error(`WP ${res.status}: ${typeof data === "string" ? data : JSON.stringify(data)}`);
  }
  return data;
}

export async function testWpConnection(
  baseUrl: string,
  username: string,
  appPassword: string
) {
  return wpFetch(baseUrl, username, appPassword, "/wp/v2/users/me");
}

export async function listWpCategories(
  baseUrl: string,
  username: string,
  appPassword: string
) {
  type Cat = { id: number; name: string; slug: string; parent: number };
  const all: Cat[] = [];
  for (let page = 1; page <= 20; page++) {
    let batch: Cat[];
    try {
      batch = (await wpFetch(
        baseUrl,
        username,
        appPassword,
        `/wp/v2/categories?per_page=100&page=${page}`
      )) as Cat[];
    } catch (err) {
      if (page > 1) break; // WP answers 400 for a page past the last one
      throw err;
    }
    all.push(...batch);
    if (batch.length < 100) break;
  }
  return all;
}

export async function createWpCategory(
  baseUrl: string,
  username: string,
  appPassword: string,
  name: string
) {
  const slug = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80) || `cat-${Date.now()}`;

  return wpFetch(baseUrl, username, appPassword, "/wp/v2/categories", {
    method: "POST",
    body: JSON.stringify({ name: name.trim(), slug }),
  }) as Promise<{ id: number; name: string; slug: string }>;
}

export async function uploadWpMedia(
  baseUrl: string,
  username: string,
  appPassword: string,
  input: { bytes: Buffer; filename: string; mime: string; alt?: string; title?: string }
) {
  const url = `${baseUrl.replace(/\/$/, "")}/wp-json/wp/v2/media`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: basicAuth(username, appPassword),
      "Content-Disposition": `attachment; filename="${input.filename}"`,
      "Content-Type": input.mime,
    },
    body: new Uint8Array(input.bytes),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    throw new Error(`WP media ${res.status}: ${JSON.stringify(data)}`);
  }

  if (input.alt || input.title) {
    await wpFetch(baseUrl, username, appPassword, `/wp/v2/media/${data.id}`, {
      method: "POST",
      body: JSON.stringify({
        alt_text: input.alt ?? "",
        title: input.title ?? input.filename,
      }),
    });
  }

  return data as { id: number; source_url?: string };
}

export async function createWpDraftPost(
  baseUrl: string,
  username: string,
  appPassword: string,
  input: {
    title: string;
    content: string;
    categories?: number[];
    status?: "draft" | "publish";
    featuredMediaId?: number;
    excerpt?: string;
    slug?: string;
    seo?: {
      focusKeyword?: string;
      seoTitle?: string;
      metaDescription?: string;
    };
  }
) {
  const meta: Record<string, string> = {};
  if (input.seo?.focusKeyword) meta.rank_math_focus_keyword = input.seo.focusKeyword;
  if (input.seo?.seoTitle) meta.rank_math_title = input.seo.seoTitle;
  if (input.seo?.metaDescription) meta.rank_math_description = input.seo.metaDescription;

  const post = (await wpFetch(baseUrl, username, appPassword, "/wp/v2/posts", {
    method: "POST",
    body: JSON.stringify({
      title: input.title,
      content: input.content,
      status: input.status ?? "draft",
      categories: input.categories ?? [],
      featured_media: input.featuredMediaId ?? 0,
      excerpt: input.excerpt ?? "",
      ...(input.slug ? { slug: input.slug } : {}),
      ...(Object.keys(meta).length ? { meta } : {}),
    }),
  })) as { id: number; link?: string };

  // Rank Math meta sometimes needs an explicit update after create
  if (post?.id && Object.keys(meta).length) {
    try {
      await wpFetch(baseUrl, username, appPassword, `/wp/v2/posts/${post.id}`, {
        method: "POST",
        body: JSON.stringify({ meta }),
      });
    } catch {
      // non-fatal — draft still published
    }
  }

  return post;
}

/** Move a WP post to Trash (not permanent). */
/** Reads back a post's meta and confirms the Rank Math fields actually saved. */
export async function verifyRankMathMeta(
  baseUrl: string,
  username: string,
  appPassword: string,
  postId: number,
  expected: { focusKeyword?: string; seoTitle?: string; metaDescription?: string }
) {
  const expectedMeta: Record<string, string> = {};
  if (expected.focusKeyword) expectedMeta.rank_math_focus_keyword = expected.focusKeyword;
  if (expected.seoTitle) expectedMeta.rank_math_title = expected.seoTitle;
  if (expected.metaDescription) expectedMeta.rank_math_description = expected.metaDescription;

  if (!Object.keys(expectedMeta).length) {
    return { verified: true, mismatches: [] as string[] };
  }

  const post = (await wpFetch(
    baseUrl,
    username,
    appPassword,
    `/wp/v2/posts/${postId}?context=edit&_fields=meta`
  )) as { meta?: Record<string, unknown> };

  const actual = post.meta ?? {};
  const mismatches = Object.entries(expectedMeta)
    .filter(([k, v]) => actual[k] !== v)
    .map(([k]) => k);

  return { verified: mismatches.length === 0, mismatches };
}

export async function getWpPostByUrl(
  baseUrl: string,
  username: string,
  appPassword: string,
  wpPostId: number
) {
  return wpFetch(
    baseUrl,
    username,
    appPassword,
    `/wp/v2/posts/${wpPostId}?_fields=id,title,content,excerpt,link`
  ) as Promise<{
    id: number;
    title?: { rendered?: string };
    content?: { rendered?: string };
    excerpt?: { rendered?: string };
    link?: string;
  }>;
}

export async function deleteWpPost(
  baseUrl: string,
  username: string,
  appPassword: string,
  postId: number
) {
  return wpFetch(baseUrl, username, appPassword, `/wp/v2/posts/${postId}`, {
    method: "DELETE",
  });
}

/**
 * Paginated fetch of ALL published items of a type (posts, pages, or a
 * custom post type slug). WP REST caps per_page at 100, so we loop pages
 * until a short page comes back. Includes rendered content so the scanner
 * can detect internal links for orphan-page detection.
 */
export async function listWpPosts(
  baseUrl: string,
  username: string,
  appPassword: string,
  opts: { type?: string; maxPages?: number } = {}
) {
  const type = opts.type ?? "posts";
  const perPage = 100;
  const maxPages = opts.maxPages ?? 20; // hard ceiling: 2000 items/type
  const all: Array<{
    id: number;
    title?: { rendered?: string };
    link?: string;
    excerpt?: { rendered?: string };
    content?: { rendered?: string };
  }> = [];

  for (let page = 1; page <= maxPages; page++) {
    let batch;
    try {
      batch = (await wpFetch(
        baseUrl,
        username,
        appPassword,
        `/wp/v2/${type}?per_page=${perPage}&page=${page}&status=publish&_fields=id,title,link,excerpt,content`
      )) as typeof all;
    } catch (err) {
      // WP returns 400 rest_post_invalid_page_number once past the last page
      if (page > 1) break;
      throw err;
    }
    if (!batch?.length) break;
    all.push(...batch);
    if (batch.length < perPage) break;
  }

  return all;
}

/** Discover public custom post types beyond the built-in post/page. */
export async function listWpPostTypes(
  baseUrl: string,
  username: string,
  appPassword: string
) {
  const types = (await wpFetch(
    baseUrl,
    username,
    appPassword,
    "/wp/v2/types"
  )) as Record<string, { slug: string; rest_base?: string; viewable?: boolean }>;

  return Object.values(types)
    .filter((t) => t.viewable && !["post", "page", "attachment"].includes(t.slug))
    .map((t) => t.rest_base || t.slug);
}
