"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";

type Site = {
  id: string;
  name: string;
  baseUrl: string;
  rankMathActive: boolean;
  createdAt: string;
  _count?: { categories: number; contents: number };
};

export default function SitesPage() {
  const [sites, setSites] = useState<Site[]>([]);
  const [msg, setMsg] = useState("");
  const [ok, setOk] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [factsSite, setFactsSite] = useState<Site | null>(null);
  const [factsText, setFactsText] = useState("");
  const [error, setError] = useState("");
  const [menuId, setMenuId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const data = await api<{ sites: Site[] }>("/sites");
    setSites(data.sites ?? []);
  }, []);

  useEffect(() => {
    load().catch((err) => setError(err instanceof Error ? err.message : "Failed"));
  }, [load]);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setMsg("");
    setOk(null);
    const form = e.currentTarget; // keep a reference: currentTarget is null after an await
    const fd = new FormData(form);
    const payload = {
      name: String(fd.get("name") ?? ""),
      baseUrl: String(fd.get("baseUrl") ?? ""),
      wpUsername: String(fd.get("wpUsername") ?? ""),
      wpAppPassword: String(fd.get("wpAppPassword") ?? ""),
    };

    try {
      await api("/wordpress/test", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      const createJson = await api<{ site: { id: string } }>("/sites", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      const scanJson = await api<{
        scanned: number;
        pagesIndexed?: number;
        orphanCount?: number;
      }>(`/wordpress/${createJson.site.id}/scan`, { method: "POST", body: "{}" });
      setOk(true);
      setMsg(
        `Connected. Scanned ${scanJson.scanned} categories${
          scanJson.pagesIndexed != null ? `, ${scanJson.pagesIndexed} pages/posts` : ""
        }${scanJson.orphanCount ? ` (${scanJson.orphanCount} orphan pages found)` : ""}.`
      );
      setShowAdd(false);
      form.reset();
      await load();
    } catch (err) {
      setOk(false);
      setMsg(err instanceof Error ? err.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  async function rescan(id: string) {
    setBusyId(id);
    setError("");
    try {
      const scan = await api<{
        scanned: number;
        pagesIndexed?: number;
        orphanCount?: number;
      }>(`/wordpress/${id}/scan`, {
        method: "POST",
        body: "{}",
      });
      setMsg(
        `Rescanned ${scan.scanned} categories${
          scan.pagesIndexed != null ? `, ${scan.pagesIndexed} pages/posts` : ""
        }${scan.orphanCount ? ` (${scan.orphanCount} orphan pages)` : ""}.`
      );
      setOk(true);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Rescan failed");
    } finally {
      setBusyId(null);
    }
  }

  async function remove(id: string, name: string) {
    if (!confirm(`Disconnect “${name}”? Content records for this site will also be removed.`)) {
      return;
    }
    setBusyId(id);
    try {
      await api(`/sites/${id}`, { method: "DELETE" });
      setMsg(`Removed ${name}`);
      setOk(true);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed");
    } finally {
      setBusyId(null);
    }
  }

  async function openFacts(s: Site) {
    setBusyId(s.id);
    setError("");
    try {
      const data = await api<{ facts: Array<{ key: string; value: string }> }>(
        `/sites/${s.id}/facts`
      );
      setFactsText(
        (data.facts ?? []).map((f) => `${f.key}: ${f.value}`).join("\n")
      );
      setFactsSite(s);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load facts");
    } finally {
      setBusyId(null);
    }
  }

  async function saveFacts(e: FormEvent) {
    e.preventDefault();
    if (!factsSite) return;
    setBusy(true);
    setError("");
    const facts = factsText
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const i = line.indexOf(":");
        if (i === -1) return { key: line, value: "" };
        return { key: line.slice(0, i).trim(), value: line.slice(i + 1).trim() };
      })
      .filter((f) => f.key && f.value);
    try {
      await api(`/sites/${factsSite.id}/facts`, {
        method: "PUT",
        body: JSON.stringify({ facts }),
      });
      setMsg(`Saved ${facts.length} business facts for ${factsSite.name}`);
      setOk(true);
      setFactsSite(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="dash-head">
        <div>
          <h1>Sites</h1>
          <p className="lead">
            Connected WordPress sites. Connect once, then generate/publish from the Dashboard.
          </p>
        </div>
        <button type="button" className="add-btn" onClick={() => setShowAdd(true)} title="Add site">
          +
        </button>
      </div>

      {msg ? <p className={`msg ${ok ? "ok" : "err"}`}>{msg}</p> : null}
      {error ? <p className="msg err">{error}</p> : null}

      <div className="list">
        {sites.length === 0 ? (
          <p className="muted">No sites yet. Hit + to connect WordPress.</p>
        ) : (
          sites.map((s) => (
            <div key={s.id} className="row">
              <div className="row-main">
                <strong>{s.name}</strong>
                <div className="meta">
                  <a href={s.baseUrl} target="_blank" rel="noreferrer">
                    {s.baseUrl}
                  </a>
                  {" · "}
                  {s._count?.categories ?? 0} categories · {s._count?.contents ?? 0} content
                  {s.rankMathActive ? " · Rank Math" : ""}
                </div>
              </div>
              <div className="actions">
                {busyId === s.id ? <span className="spinner sm" /> : null}
                <div className="actions-quick">
                  <button type="button" disabled={busyId === s.id} onClick={() => rescan(s.id)}>
                    Rescan
                  </button>
                  <button type="button" disabled={busyId === s.id} onClick={() => openFacts(s)}>
                    Facts
                  </button>
                  <button
                    type="button"
                    className="danger"
                    disabled={busyId === s.id}
                    onClick={() => remove(s.id, s.name)}
                  >
                    Delete
                  </button>
                </div>
                <div className="more-wrap more-mobile-only">
                  <button
                    type="button"
                    className="ghost icon-more"
                    aria-label="More actions"
                    aria-expanded={menuId === s.id}
                    disabled={busyId === s.id}
                    onClick={() => setMenuId(menuId === s.id ? null : s.id)}
                  >
                    ⋮
                  </button>
                  {menuId === s.id ? (
                    <div className="more-menu">
                      <button
                        type="button"
                        onClick={() => {
                          setMenuId(null);
                          rescan(s.id);
                        }}
                      >
                        Rescan
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setMenuId(null);
                          openFacts(s);
                        }}
                      >
                        Facts
                      </button>
                      <button
                        type="button"
                        className="danger"
                        onClick={() => {
                          setMenuId(null);
                          remove(s.id, s.name);
                        }}
                      >
                        Delete
                      </button>
                    </div>
                  ) : null}
                </div>
              </div>
            </div>
          ))
        )}
      </div>

      {showAdd ? (
        <div className="modal" role="dialog">
          <form className="modal-card form" onSubmit={onSubmit}>
            <div className="modal-head">
              <h2>Connect WordPress</h2>
              <button type="button" className="icon-close" aria-label="Close" onClick={() => setShowAdd(false)}>
                ×
              </button>
            </div>
            <label>
              Site name
              <input name="name" required placeholder="LisbonYacht" autoComplete="off" />
            </label>
            <label>
              Site URL
              <input name="baseUrl" required type="url" placeholder="https://example.com" autoComplete="off" />
            </label>
            <label>
              WP username
              <input name="wpUsername" required placeholder="newadmin_lisbon" autoComplete="off" />
            </label>
            <label>
              Application Password
              <input
                name="wpAppPassword"
                required
                type="password"
                placeholder="xxxx xxxx xxxx xxxx xxxx xxxx"
                autoComplete="new-password"
              />
            </label>
            <p className="muted" style={{ marginTop: "-0.5rem" }}>
              Create on that site: WP Admin → Users → Profile → Application Passwords. Paste it here (not the login password).
            </p>
            <button type="submit" disabled={busy}>
              {busy ? (
                <span className="btn-row">
                  <span className="spinner sm" /> Connecting…
                </span>
              ) : (
                "Connect & scan"
              )}
            </button>
          </form>
        </div>
      ) : null}

      {factsSite ? (
        <div className="modal" role="dialog">
          <form className="modal-card form" onSubmit={saveFacts}>
            <div className="modal-head">
              <h2>Business facts — {factsSite.name}</h2>
              <button
                type="button"
                className="icon-close"
                aria-label="Close"
                onClick={() => setFactsSite(null)}
              >
                ×
              </button>
            </div>
            <p className="muted">
              One fact per line as <code>key: value</code>. Used on Generate so the AI does not invent business claims.
            </p>
            <label>
              Facts
              <textarea
                rows={10}
                value={factsText}
                onChange={(e) => setFactsText(e.target.value)}
                placeholder={"location: Lisbon, Portugal\nservices: private yacht charters\ntone: luxury leisure"}
              />
            </label>
            <button type="submit" disabled={busy}>
              {busy ? "Saving…" : "Save facts"}
            </button>
          </form>
        </div>
      ) : null}
    </>
  );
}
