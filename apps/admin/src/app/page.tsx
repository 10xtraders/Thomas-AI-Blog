"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import DocEditor from "@/components/DocEditor";
import { toastErr, toastOk, toastWarn } from "@/components/ToastHost";
import { api, API_BASE, getToken } from "@/lib/api";
import { friendlyError } from "@/lib/errors";

type Site = { id: string; name: string; baseUrl: string };
type Content = {
  id: string;
  title: string;
  status: string;
  language: string;
  siteId: string;
  bodyHtml?: string | null;
  seoTitle?: string | null;
  metaDescription?: string | null;
  focusKeyword?: string | null;
  wpPostId?: number | null;
  wpUrl?: string | null;
  slug?: string | null;
  schemaJson?: unknown;
  rankMathVerified?: boolean | null;
  rankMathMismatches?: string[];
  parentContentId?: string | null;
  hasFeaturedImage?: boolean;
  site?: { id: string; name: string };
};

function extractLinks(html?: string | null) {
  if (!html) return [] as Array<{ href: string; text: string }>;
  return [
    ...html.matchAll(/<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi),
  ].map((m) => ({
    href: m[1],
    text:
      m[2]
        .replace(/<[^>]+>/g, "")
        .replace(/\s+/g, " ")
        .trim() || m[1],
  }));
}

function hasSchema(schema: unknown) {
  if (!schema || typeof schema !== "object") return false;
  return Object.keys(schema as object).length > 0;
}

function FeaturedPreview({ id }: { id: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let url: string | null = null;
    let cancelled = false;
    const token = getToken();
    fetch(`${API_BASE}/content/${id}/featured-image`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
      .then((r) => {
        if (!r.ok) throw new Error("none");
        return r.blob();
      })
      .then((blob) => {
        if (cancelled) return;
        url = URL.createObjectURL(blob);
        setSrc(url);
      })
      .catch(() => {
        if (!cancelled) setSrc(null);
      });
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [id]);
  if (!src) {
    return (
      <p>
        <strong>Image</strong> — none yet. Generated on Generate / send to
        WordPress when the image key has credit.
      </p>
    );
  }
  return (
    <div className="featured-preview-wrap">
      <strong>Featured image</strong>
      <img className="featured-preview" src={src} alt="Featured" />
    </div>
  );
}

type Filter = "all" | "idea" | "generated" | "review" | "published";
type JobKind = "generate" | "publish" | "localize";
type JobProgress = { id: string; kind: JobKind; pct: number; label: string };

const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "idea", label: "Ideas" },
  { id: "generated", label: "Generated" },
  { id: "review", label: "Review" },
  { id: "published", label: "On WP" },
];

function matchesFilter(c: Content, f: Filter) {
  if (f === "all") return true;
  if (f === "published")
    return !!c.wpUrl || c.status === "PUBLISHED" || c.status === "UPDATED";
  if (f === "review")
    return c.status === "HUMAN_REVIEW" || c.status === "APPROVED";
  if (f === "generated")
    return (
      !!c.bodyHtml &&
      !c.wpUrl &&
      c.status !== "PUBLISHED" &&
      c.status !== "UPDATED"
    );
  if (f === "idea") return !c.bodyHtml && !c.wpUrl;
  return true;
}

function statusClass(status: string) {
  const s = status.toLowerCase();
  if (s === "published" || s === "updated") return "st-published";
  if (s === "human_review" || s === "approved") return "st-review";
  if (s === "ai_generated" || s === "draft") return "st-generated";
  if (s === "idea" || s === "research") return "st-idea";
  return "st-muted";
}

/** If model stored escaped tags (&lt;p&gt;), turn into real HTML for display/edit */
function readableHtml(raw: string | null | undefined) {
  const s = raw || "";
  if (!s) return "<p></p>";
  if (s.includes("<") && !s.includes("&lt;")) return s;
  if (s.includes("&lt;") || s.includes("&gt;")) {
    const t = document.createElement("textarea");
    t.innerHTML = s;
    return t.value;
  }
  return s;
}

export default function DashboardPage() {
  const [contents, setContents] = useState<Content[]>([]);
  const [sites, setSites] = useState<Site[]>([]);
  const [msg, setMsg] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [createSiteId, setCreateSiteId] = useState("");
  const [createCategories, setCreateCategories] = useState<
    Array<{ id: string; name: string }>
  >([]);
  const [categoryMode, setCategoryMode] = useState<"existing" | "custom">(
    "existing",
  );
  const [customCategory, setCustomCategory] = useState("");
  const [preview, setPreview] = useState<Content | null>(null);
  const [edit, setEdit] = useState<Content | null>(null);
  const [menuId, setMenuId] = useState<string | null>(null);
  const [editBodyHtml, setEditBodyHtml] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const [job, setJob] = useState<JobProgress | null>(null);
  const [dialog, setDialog] = useState<
    | { kind: "delete"; id: string; title: string; linked: boolean }
    | { kind: "bulk-delete"; ids: string[]; linkedCount: number }
    | { kind: "publish"; id: string; title: string }
    | { kind: "localize"; id: string; title: string }
    | { kind: "notice"; title: string; body: string }
    | null
  >(null);

  function fail(err: unknown) {
    toastErr(friendlyError(err));
  }

  function ok(text: string) {
    setMsg(text);
    toastOk(text);
  }

  const filtered = useMemo(
    () => contents.filter((c) => matchesFilter(c, filter)),
    [contents, filter],
  );

  const load = useCallback(async () => {
    const [cJson, sJson] = await Promise.all([
      api<{ contents: Content[] }>("/content"),
      api<{ sites: Site[] }>("/sites"),
    ]);
    setContents(cJson.contents ?? []);
    setSites(sJson.sites ?? []);
  }, []);

  useEffect(() => {
    load().catch((err) => fail(err));
  }, [load]);

  // Polls the backend job status for a "generate" job and resolves with the
  // final result once done, updating the progress bar with real pct/label
  // from the server as it goes.
  async function pollJob<T = unknown>(
    id: string,
    kind: JobKind,
    path: "generate" | "publish" | "localize",
  ): Promise<T> {
    while (true) {
      const status = await api<{
        status: "running" | "done" | "error";
        pct: number;
        label: string;
        result?: T;
        error?: string;
      }>(`/content/${id}/${path}/status`).catch((err: unknown) => {
        const m = err instanceof Error ? err.message : String(err);
        if (/no (publish|generation|localization) job/i.test(m)) {
          return {
            status: "running" as const,
            pct: 0,
            label: "",
            result: undefined,
            error: undefined,
          };
        }
        throw err;
      });

      setJob((prev) =>
        prev && prev.kind === kind && prev.id === id
          ? {
              ...prev,
              pct: status.pct,
              /*               pct: Math.max(prev.pct, status.pct), */
              label: status.label || prev.label,
            }
          : prev,
      );

      if (status.status === "done") return (status.result ?? {}) as T;
      if (status.status === "error")
        throw new Error(status.error || `${path} failed`);

      await new Promise((r) => setTimeout(r, 700));
    }
  }

  function startJob(id: string, kind: JobKind) {
    setJob({
      id,
      kind,
      pct: 5,
      label:
        kind === "generate"
          ? "Generating…"
          : kind === "publish"
            ? "Checking image keys…"
            : "Translating…",
    });
  }

  async function finishJob() {
    setJob((prev) => (prev ? { ...prev, pct: 100, label: "Done" } : null));
    await new Promise((r) => setTimeout(r, 350));
    setJob(null);
  }

  useEffect(() => {
    if (!createSiteId) {
      setCreateCategories([]);
      return;
    }
    api<{ categories: Array<{ id: string; name: string }> }>(
      `/sites/${createSiteId}/categories?refresh=1`,
    )
      .then((d) => setCreateCategories(d.categories ?? []))
      .catch(() => setCreateCategories([]));
  }, [createSiteId]);

  async function onCreate(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setCreating(true);
    setMsg("");
    const fd = new FormData(e.currentTarget);
    const payload = {
      siteId: String(fd.get("siteId") ?? ""),
      categoryId:
        categoryMode === "existing"
          ? String(fd.get("categoryId") ?? "") || undefined
          : undefined,
      customCategory:
        categoryMode === "custom"
          ? customCategory.trim() || undefined
          : undefined,
      title: String(fd.get("title") ?? ""),
      language: String(fd.get("language") ?? "en"),
      brief: String(fd.get("brief") ?? "") || undefined,
      autoGenerate: fd.get("autoGenerate") === "on",
    };
    try {
      const { content } = await api<{ content: Content }>("/content", {
        method: "POST",
        body: JSON.stringify({
          siteId: payload.siteId,
          categoryId: payload.categoryId,
          customCategory: payload.customCategory,
          title: payload.title,
          language: payload.language,
        }),
      });
      if (payload.autoGenerate) {
        setBusyId(content.id);
        startJob(content.id, "generate");
        await api(`/content/${content.id}/generate`, {
          method: "POST",
          body: JSON.stringify({ provider: "auto", brief: payload.brief }),
        });
        await pollJob(content.id, "generate", "generate");
        await finishJob();
        ok(`Generated: ${content.title}`);
      } else {
        ok(`Idea saved: ${content.title}`);
      }
      setShowCreate(false);
      await load();
    } catch (err) {
      setJob(null);
      fail(err);
    } finally {
      setBusyId(null);
      setCreating(false);
    }
  }

  async function runGenerate(id: string) {
    setMenuId(null);
    setBusyId(id);
    setMsg("");
    startJob(id, "generate");
    try {
      await api(`/content/${id}/generate`, {
        method: "POST",
        body: JSON.stringify({ provider: "auto" }),
      });
      const res = await pollJob<{
        provider: string;
        fallbackFrom?: string | null;
        usage?: {
          estimatedUsdLabel?: string;
          inputTokens?: number;
          outputTokens?: number;
        };
      }>(id, "generate", "generate");
      await finishJob();
      const via = res.fallbackFrom
        ? `${res.provider} (fell back after ${res.fallbackFrom} failed)`
        : res.provider;
      ok(
        res.usage?.estimatedUsdLabel
          ? `Generated via ${via} · ${res.usage.estimatedUsdLabel}`
          : `Generated via ${via}`,
      );
      await load();
    } catch (err) {
      setJob(null);
      fail(err);
    } finally {
      setBusyId(null);
    }
  }

  function askLocalize(id: string) {
    setMenuId(null);
    const item = contents.find((c) => c.id === id);
    setDialog({ kind: "localize", id, title: item?.title ?? "this article" });
  }

  async function runLocalize(id: string, language: "pt" | "fr") {
    setDialog(null);
    setBusyId(id);
    startJob(id, "localize");
    try {
      await api(`/content/${id}/localize`, {
        method: "POST",
        body: JSON.stringify({ languages: [language] }),
      });
      const res = await pollJob<{
        children: Array<{ id: string; language: string; title: string }>;
      }>(id, "localize", "localize");
      await finishJob();
      const langs = (res.children ?? [])
        .map((c) => c.language.toUpperCase())
        .join(", ");
      ok(
        langs
          ? `Translations ready: ${langs}. Open each card to preview, then send to WordPress.`
          : "Translations saved",
      );
      await load();
    } catch (err) {
      setJob(null);
      fail(err);
    } finally {
      setBusyId(null);
    }
  }

  async function runApprovePublish(id: string) {
    setMenuId(null);
    const item = contents.find((c) => c.id === id);
    setDialog({
      kind: "publish",
      id,
      title: item?.title ?? "this article",
    });
  }

  async function confirmPublish(id: string) {
    setDialog(null);
    setBusyId(id);
    setMsg("");
    startJob(id, "publish");
    try {
      await api(`/content/${id}/approve`, { method: "POST", body: "{}" });
      const started = await api<{
        jobId?: string;
        status?: string;
        content?: Content;
        alreadyPublished?: boolean;
      }>(`/content/${id}/publish`, {
        method: "POST",
        body: JSON.stringify({ withImage: true, status: "draft" }),
      });
      if (started.alreadyPublished) {
        await finishJob();
        ok("Already on WordPress");
        await load();
        return;
      }
      const res = await pollJob<{
        content: Content;
        imageError?: string | null;
        hasFeaturedImage?: boolean;
        alreadyPublished?: boolean;
      }>(id, "publish", "publish");
      await finishJob();
      const url = res.content?.wpUrl;
      const hasImage = res.hasFeaturedImage === true;
      if (!hasImage) {
        const reason = friendlyError(
          res.imageError || "Featured image was not attached.",
        );
        const text = url
          ? `Draft on WordPress. Featured image skipped: ${reason}`
          : `Published draft. Featured image skipped: ${reason}`;
        setMsg(text);
        toastWarn(text);
      } else {
        ok(
          url
            ? "Published to WordPress with featured image."
            : "Published draft",
        );
      }
      await load();
    } catch (err) {
      setJob(null);
      fail(err);
    } finally {
      setBusyId(null);
    }
  }

  function askDelete(id: string) {
    setMenuId(null);
    const item = contents.find((c) => c.id === id);
    setDialog({
      kind: "delete",
      id,
      title: item?.title ?? "this item",
      linked: Boolean(item?.wpPostId || item?.wpUrl),
    });
  }

  async function confirmDelete(id: string, deleteWp: boolean, linked: boolean) {
    setDialog(null);
    setBusyId(id);
    setMsg("");
    try {
      const res = await api<{
        ok: boolean;
        wpDeleted?: boolean;
        hadWp?: boolean;
        wpUrl?: string | null;
      }>(`/content/${id}?deleteWp=${deleteWp ? "true" : "false"}`, {
        method: "DELETE",
      });
      setSelected((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      await load();
      if (res.wpDeleted) {
        setDialog({
          kind: "notice",
          title: "Deleted",
          body: "Removed from the dashboard and moved the WordPress draft to Trash.",
        });
      } else if (linked && !deleteWp) {
        setDialog({
          kind: "notice",
          title: "Deleted from dashboard only",
          body: "To remove the WP draft, open WordPress Admin → Posts (or Trash) and delete it there.",
        });
      } else {
        ok("Deleted");
      }
    } catch (err) {
      fail(err);
    } finally {
      setBusyId(null);
    }
  }

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleSelectAll() {
    setSelected((prev) =>
      prev.size === filtered.length && filtered.every((c) => prev.has(c.id))
        ? new Set()
        : new Set(filtered.map((c) => c.id)),
    );
  }

  function askBulkDelete() {
    const ids = [...selected];
    if (ids.length === 0) return;
    const linkedCount = contents.filter(
      (c) => ids.includes(c.id) && (c.wpPostId || c.wpUrl),
    ).length;
    setDialog({ kind: "bulk-delete", ids, linkedCount });
  }

  async function confirmBulkDelete(
    ids: string[],
    deleteWp: boolean,
    linkedCount: number,
  ) {
    setDialog(null);
    setBulkBusy(true);
    setMsg("");
    try {
      const results = await Promise.allSettled(
        ids.map((id) =>
          api(`/content/${id}?deleteWp=${deleteWp ? "true" : "false"}`, {
            method: "DELETE",
          }),
        ),
      );
      const failed = results.filter((r) => r.status === "rejected").length;
      const deleted = ids.length - failed;
      setSelected(new Set());
      await load();
      if (failed) {
        ok(`Deleted ${deleted}, failed ${failed}`);
      } else if (linkedCount > 0 && !deleteWp) {
        setDialog({
          kind: "notice",
          title: "Deleted from dashboard only",
          body: `Removed ${deleted} item(s) here. To remove WP drafts, open WordPress Admin → Posts (or Trash) and delete them there.`,
        });
      } else if (linkedCount > 0 && deleteWp) {
        setDialog({
          kind: "notice",
          title: "Deleted",
          body: `Removed ${deleted} item(s). Linked WordPress drafts were moved to Trash.`,
        });
      } else {
        ok(`Deleted ${deleted}`);
      }
    } catch (err) {
      fail(err);
    } finally {
      setBulkBusy(false);
    }
  }

  async function saveEdit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!edit) return;
    setBusyId(edit.id);
    const fd = new FormData(e.currentTarget);
    try {
      await api(`/content/${edit.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          title: String(fd.get("title") ?? ""),
          bodyHtml: editBodyHtml || String(fd.get("bodyHtml") ?? ""),
          seoTitle: String(fd.get("seoTitle") ?? ""),
          metaDescription: String(fd.get("metaDescription") ?? ""),
          focusKeyword: String(fd.get("focusKeyword") ?? ""),
        }),
      });
      setEdit(null);
      ok("Saved");
      await load();
    } catch (err) {
      fail(err);
    } finally {
      setBusyId(null);
    }
  }

  function openEdit(c: Content) {
    setMenuId(null);
    setEdit(c);
    setEditBodyHtml(readableHtml(c.bodyHtml));
  }

  const allFilteredSelected =
    filtered.length > 0 && filtered.every((c) => selected.has(c.id));

  return (
    <>
      <div className="dash-head">
        <div>
          <h1>Dashboard</h1>
          <p className="lead">
            Your content queue — generate, review, then send a draft to
            WordPress.
          </p>
        </div>
        <button
          type="button"
          className="add-btn"
          onClick={() => {
            setCreateSiteId(sites[0]?.id ?? "");
            setShowCreate(true);
          }}
          title="New content"
        >
          +
        </button>
      </div>

      {msg ? <p className="msg ok">{msg}</p> : null}

      <div className="filter-bar" role="tablist" aria-label="Filter content">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            role="tab"
            aria-selected={filter === f.id}
            className={`filter-chip${filter === f.id ? " active" : ""}`}
            onClick={() => {
              setFilter(f.id);
              setSelected(new Set());
            }}
          >
            {f.label}
            <span className="filter-count">
              {contents.filter((c) => matchesFilter(c, f.id)).length}
            </span>
          </button>
        ))}
      </div>

      {filtered.length > 0 ? (
        <div className="bulk-bar">
          <label className="bulk-check">
            <input
              type="checkbox"
              checked={allFilteredSelected}
              ref={(el) => {
                if (el)
                  el.indeterminate =
                    selected.size > 0 &&
                    !allFilteredSelected &&
                    filtered.some((c) => selected.has(c.id));
              }}
              onChange={toggleSelectAll}
            />
            Select all
          </label>
          {selected.size > 0 ? (
            <button
              type="button"
              className="danger icon-btn"
              disabled={bulkBusy}
              onClick={() => askBulkDelete()}
              title={`Delete ${selected.size} selected`}
              aria-label={`Delete ${selected.size} selected`}
            >
              {bulkBusy ? (
                <span className="spinner sm" />
              ) : (
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  aria-hidden
                >
                  <path
                    d="M3 6h18M8 6V4h8v2m1 0v14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2V6h10z"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              )}
              <span>{selected.size}</span>
            </button>
          ) : null}
        </div>
      ) : null}

      <div className="list">
        {contents.length === 0 ? (
          <p className="muted">Nothing yet. Hit + to add a topic.</p>
        ) : filtered.length === 0 ? (
          <p className="muted">No items in this filter.</p>
        ) : (
          filtered.map((c) => {
            const busy = busyId === c.id;
            const canPublish =
              !!c.bodyHtml && !c.wpUrl && c.status !== "PUBLISHED";
            const rowJob = job?.id === c.id ? job : null;
            return (
              <div key={c.id} className={`row${busy ? " row-busy" : ""}`}>
                <label className="row-check">
                  <input
                    type="checkbox"
                    checked={selected.has(c.id)}
                    onChange={() => toggleSelect(c.id)}
                    disabled={bulkBusy}
                  />
                </label>
                <div className="row-main">
                  <strong>{c.title}</strong>
                  <div className="meta">
                    {c.site?.name ?? c.siteId} ·{" "}
                    <span className={`st ${statusClass(c.status)}`}>
                      {c.status.replace(/_/g, " ")}
                    </span>
                    {" · "}
                    {c.language}
                  </div>
                  {c.wpUrl ? (
                    <div className="row-link">
                      <a href={c.wpUrl} target="_blank" rel="noreferrer">
                        <span className="row-link-full">{c.wpUrl}</span>
                        <span className="row-link-short">
                          Open on WordPress
                        </span>
                      </a>
                    </div>
                  ) : null}
                  {rowJob ? (
                    <div className="job-progress row-progress" role="status">
                      <div className="job-progress-top">
                        <span>{rowJob.label}</span>
                        <strong>{Math.round(rowJob.pct)}%</strong>
                      </div>
                      <div className="job-progress-track">
                        <div
                          className="job-progress-fill"
                          style={{ width: `${rowJob.pct}%` }}
                        />
                      </div>
                    </div>
                  ) : null}
                </div>
                <div className="actions">
                  {busy && !rowJob ? <span className="spinner sm" /> : null}
                  <div className="actions-quick">
                    {c.wpUrl ? (
                      <a
                        className="btn-link"
                        href={c.wpUrl}
                        target="_blank"
                        rel="noreferrer"
                      >
                        View
                      </a>
                    ) : (
                      <button
                        type="button"
                        disabled={busy || bulkBusy}
                        onClick={() => runGenerate(c.id)}
                      >
                        {c.bodyHtml ? "Regenerate" : "Generate"}
                      </button>
                    )}
                    {c.bodyHtml ? (
                      <button
                        type="button"
                        disabled={busy || bulkBusy}
                        onClick={() => {
                          setMenuId(null);
                          setPreview(c);
                        }}
                      >
                        Preview
                      </button>
                    ) : null}
                  </div>
                  <div className="more-wrap">
                    <button
                      type="button"
                      className="ghost icon-more"
                      aria-label="More actions"
                      aria-expanded={menuId === c.id}
                      disabled={busy || bulkBusy}
                      onClick={() => setMenuId(menuId === c.id ? null : c.id)}
                    >
                      ⋮
                    </button>
                    {menuId === c.id ? (
                      <div className="more-menu">
                        {!c.wpUrl ? (
                          <button
                            type="button"
                            disabled={busy || bulkBusy}
                            onClick={() => {
                              setMenuId(null);
                              runGenerate(c.id);
                            }}
                          >
                            {c.bodyHtml ? "Regenerate" : "Generate"}
                          </button>
                        ) : (
                          <a href={c.wpUrl} target="_blank" rel="noreferrer">
                            View on WordPress
                          </a>
                        )}
                        {c.bodyHtml ? (
                          <button
                            type="button"
                            onClick={() => {
                              setMenuId(null);
                              setPreview(c);
                            }}
                          >
                            Preview
                          </button>
                        ) : null}
                        <button type="button" onClick={() => openEdit(c)}>
                          Edit
                        </button>
                        {c.bodyHtml &&
                        !c.parentContentId &&
                        c.language === "en" ? (
                          <button
                            type="button"
                            onClick={() => askLocalize(c.id)}
                          >
                            Translate
                          </button>
                        ) : null}
                        {canPublish ? (
                          <button
                            type="button"
                            onClick={() => runApprovePublish(c.id)}
                          >
                            Approve &amp; publish draft
                          </button>
                        ) : null}
                        <button
                          type="button"
                          className="danger"
                          onClick={() => askDelete(c.id)}
                        >
                          Delete
                        </button>
                      </div>
                    ) : null}
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>

      {showCreate ? (
        <div className="modal" role="dialog">
          <form className="modal-card form" onSubmit={onCreate}>
            <div className="modal-head">
              <h2>New content</h2>
              <button
                type="button"
                className="ghost"
                onClick={() => setShowCreate(false)}
              >
                Close
              </button>
            </div>
            <div className="help-box">
              <p>
                <strong>Title</strong> — topic for the article.
              </p>
              <p>
                <strong>Brief</strong> — guidelines only (audience, tone, what
                not to invent). Not the full post.
              </p>
              <p>
                <strong>Generate</strong> — AI writes the full blog + SEO.
              </p>
              <p>
                <strong>Approve &amp; publish</strong> — one step: accept the
                draft and send it to WordPress as a <em>draft</em> (featured
                image if the image API works).
              </p>
            </div>
            <label>
              Site
              <select
                name="siteId"
                required
                value={createSiteId}
                onChange={(e) => setCreateSiteId(e.target.value)}
              >
                <option value="" disabled>
                  Select site
                </option>
                {sites.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Category
              <select
                value={categoryMode === "custom" ? "__custom__" : "existing"}
                onChange={(e) => {
                  const custom = e.target.value === "__custom__";
                  setCategoryMode(custom ? "custom" : "existing");
                  if (!custom) setCustomCategory("");
                }}
              >
                <option value="existing">Pick from site (or none)</option>
                <option value="__custom__">Write a new category…</option>
              </select>
            </label>
            {categoryMode === "custom" ? (
              <label>
                New category name
                <input
                  value={customCategory}
                  onChange={(e) => setCustomCategory(e.target.value)}
                  required
                  placeholder="e.g. Sunset Charters"
                  autoComplete="off"
                />
              </label>
            ) : (
              <label>
                Existing category
                <select name="categoryId" defaultValue="">
                  <option value="">None (optional)</option>
                  {createCategories.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label>
              Title / topic
              <input
                name="title"
                required
                placeholder="Sunset yacht charter tips"
              />
            </label>
            <label>
              Language
              <select name="language" defaultValue="en">
                <option value="en">English</option>
                <option value="pt">Portuguese</option>
                <option value="fr">French</option>
              </select>
            </label>
            <label>
              Brief (guidelines)
              <textarea
                name="brief"
                rows={3}
                placeholder="Audience, tone, must-avoid claims…"
              />
            </label>
            <label className="check">
              <input name="autoGenerate" type="checkbox" defaultChecked />
              Generate full article now
            </label>
            <button type="submit" disabled={creating || !!busyId}>
              {creating || busyId ? (
                <span className="btn-row">
                  <span className="spinner sm" /> Working…
                </span>
              ) : (
                "Create"
              )}
            </button>
          </form>
        </div>
      ) : null}

      {preview ? (
        <div className="modal" role="dialog">
          <div className="modal-card modal-wide">
            <div className="modal-head">
              <h2>{preview.title}</h2>
              <div className="modal-actions">
                <button
                  type="button"
                  onClick={() => {
                    const c = preview;
                    setPreview(null);
                    openEdit(c);
                  }}
                >
                  Edit
                </button>
                <button
                  type="button"
                  className="icon-close"
                  aria-label="Close"
                  onClick={() => setPreview(null)}
                >
                  ×
                </button>
              </div>
            </div>
            <div className="seo-panel">
              <h3>What this draft includes</h3>
              <p>
                <strong>SEO title</strong> — {preview.seoTitle || "—"}
              </p>
              <p>
                <strong>Focus keyword</strong> — {preview.focusKeyword || "—"}
              </p>
              <p>
                <strong>Meta description</strong> —{" "}
                {preview.metaDescription || "—"}
              </p>
              <p>
                <strong>Slug</strong> — {preview.slug || "—"}
              </p>
              <p>
                <strong>Structured data</strong> —{" "}
                {hasSchema(preview.schemaJson)
                  ? "BlogPosting schema is on this draft and goes into the WordPress HTML."
                  : "Not generated yet."}
              </p>
              <div>
                <strong>Links</strong>
                {extractLinks(preview.bodyHtml).length === 0 ? (
                  <p>None in the body yet.</p>
                ) : (
                  <ul>
                    {extractLinks(preview.bodyHtml).map((l) => (
                      <li key={l.href + l.text}>
                        <a href={l.href} target="_blank" rel="noreferrer">
                          {l.text}
                        </a>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <p>
                <strong>Rank Math</strong> — the fields above are what we send
                to Rank Math. The 0–100 score only appears in the WordPress
                editor on the draft, before Publish.
                {preview.rankMathVerified === true
                  ? " Fields were confirmed on WordPress after the last send."
                  : preview.rankMathVerified === false
                    ? ` Mismatch: ${(preview.rankMathMismatches ?? []).join(", ") || "check WP editor"}.`
                    : ""}
              </p>
              <FeaturedPreview id={preview.id} />
              <p>
                <strong>Translations</strong> — English masters: use Translate
                PT + FR on the card. Each language is its own item to preview
                and send to WordPress.
              </p>
            </div>
            <div
              className="preview-html"
              dangerouslySetInnerHTML={{
                __html: readableHtml(preview.bodyHtml) || "<p>No body</p>",
              }}
            />
          </div>
        </div>
      ) : null}

      {edit ? (
        <div className="modal" role="dialog">
          <form
            className="modal-card modal-wide form form-wide"
            onSubmit={saveEdit}
          >
            <div className="modal-head">
              <h2>Edit</h2>
              <button
                type="button"
                className="ghost"
                onClick={() => setEdit(null)}
              >
                Cancel
              </button>
            </div>
            <label>
              Title
              <input name="title" defaultValue={edit.title} required />
            </label>
            <label>
              SEO title
              <input name="seoTitle" defaultValue={edit.seoTitle ?? ""} />
            </label>
            <label>
              Focus keyword
              <input
                name="focusKeyword"
                defaultValue={edit.focusKeyword ?? ""}
              />
            </label>
            <label>
              Meta description
              <textarea
                name="metaDescription"
                rows={2}
                defaultValue={edit.metaDescription ?? ""}
              />
            </label>
            <div className="field">
              <span className="field-label">Article</span>
              <span className="field-hint">
                Google Docs–style edit — formatting toolbar, no raw HTML.
              </span>
              <DocEditor
                html={readableHtml(edit.bodyHtml)}
                onChange={setEditBodyHtml}
              />
              <input
                type="hidden"
                name="bodyHtml"
                value={editBodyHtml}
                readOnly
              />
            </div>
            <button type="submit" disabled={busyId === edit.id}>
              Save
            </button>
          </form>
        </div>
      ) : null}

      {dialog?.kind === "delete" ? (
        <div className="modal" role="dialog" aria-modal="true">
          <div className="modal-card form">
            <div className="modal-head">
              <h2>Delete content</h2>
              <button
                type="button"
                className="icon-close"
                aria-label="Close"
                onClick={() => setDialog(null)}
              >
                ×
              </button>
            </div>
            <p>
              Remove <strong>{dialog.title}</strong> from the dashboard?
            </p>
            {dialog.linked ? (
              <p className="muted">
                This item is linked to a WordPress draft. Choose whether to
                trash it in WP as well.
              </p>
            ) : null}
            <div className="dialog-actions">
              <button
                type="button"
                className="ghost"
                onClick={() => setDialog(null)}
              >
                Cancel
              </button>
              {dialog.linked ? (
                <>
                  <button
                    type="button"
                    onClick={() => confirmDelete(dialog.id, false, true)}
                  >
                    Dashboard only
                  </button>
                  <button
                    type="button"
                    className="danger"
                    onClick={() => confirmDelete(dialog.id, true, true)}
                  >
                    Trash WP + delete
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="danger"
                  onClick={() => confirmDelete(dialog.id, false, false)}
                >
                  Delete
                </button>
              )}
            </div>
          </div>
        </div>
      ) : null}

      {dialog?.kind === "bulk-delete" ? (
        <div className="modal" role="dialog" aria-modal="true">
          <div className="modal-card form">
            <div className="modal-head">
              <h2>Delete selected</h2>
              <button
                type="button"
                className="icon-close"
                aria-label="Close"
                onClick={() => setDialog(null)}
              >
                ×
              </button>
            </div>
            <p>
              Delete <strong>{dialog.ids.length}</strong> selected item(s) from
              the dashboard?
            </p>
            {dialog.linkedCount > 0 ? (
              <p className="muted">
                {dialog.linkedCount} linked to WordPress drafts. Choose whether
                to trash those in WP too.
              </p>
            ) : null}
            <div className="dialog-actions">
              <button
                type="button"
                className="ghost"
                onClick={() => setDialog(null)}
              >
                Cancel
              </button>
              {dialog.linkedCount > 0 ? (
                <>
                  <button
                    type="button"
                    onClick={() =>
                      confirmBulkDelete(dialog.ids, false, dialog.linkedCount)
                    }
                  >
                    Dashboard only
                  </button>
                  <button
                    type="button"
                    className="danger"
                    onClick={() =>
                      confirmBulkDelete(dialog.ids, true, dialog.linkedCount)
                    }
                  >
                    Trash WP + delete
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="danger"
                  onClick={() => confirmBulkDelete(dialog.ids, false, 0)}
                >
                  Delete
                </button>
              )}
            </div>
          </div>
        </div>
      ) : null}

      {dialog?.kind === "localize" ? (
        <div className="modal" role="dialog" aria-modal="true">
          <div className="modal-card form">
            <div className="modal-head">
              <h2>Translate</h2>
              <button
                type="button"
                className="icon-close"
                aria-label="Close"
                onClick={() => setDialog(null)}
              >
                ×
              </button>
            </div>
            <p>
              Translate <strong>{dialog.title}</strong> into one language.
            </p>
            <div className="dialog-actions">
              <button
                type="button"
                className="ghost"
                onClick={() => setDialog(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => runLocalize(dialog.id, "pt")}
              >
                Portuguese
              </button>
              <button
                type="button"
                onClick={() => runLocalize(dialog.id, "fr")}
              >
                French
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {dialog?.kind === "publish" ? (
        <div className="modal" role="dialog" aria-modal="true">
          <div className="modal-card form">
            <div className="modal-head">
              <h2>Publish draft</h2>
              <button
                type="button"
                className="icon-close"
                aria-label="Close"
                onClick={() => setDialog(null)}
              >
                ×
              </button>
            </div>
            <p>
              Approve <strong>{dialog.title}</strong> and send it to WordPress
              as a draft?
            </p>
            <p className="muted">
              You can trash the draft in WordPress anytime.
            </p>
            <div className="dialog-actions">
              <button
                type="button"
                className="ghost"
                onClick={() => setDialog(null)}
              >
                Cancel
              </button>
              <button type="button" onClick={() => confirmPublish(dialog.id)}>
                Publish draft
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {dialog?.kind === "notice" ? (
        <div className="modal" role="dialog" aria-modal="true">
          <div className="modal-card form">
            <div className="modal-head">
              <h2>{dialog.title}</h2>
              <button
                type="button"
                className="icon-close"
                aria-label="Close"
                onClick={() => setDialog(null)}
              >
                ×
              </button>
            </div>
            <p>{dialog.body}</p>
            <div className="dialog-actions">
              <button type="button" onClick={() => setDialog(null)}>
                Dismiss
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
