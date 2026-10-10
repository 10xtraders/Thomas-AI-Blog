import type { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { estimateUsd } from "../lib/costs";
import { providerHttpError } from "../lib/providerErrors";
import { probeImageCapability } from "../lib/imageCapability";
import { withRetry, fetchWithStatus } from "../lib/retry";
import { researchTopic } from "./research";
import { rankLinkTargets, recordAppliedLinks } from "./linking";
import { saveFeaturedImage } from "../lib/featuredStore";
import {
  buildLinkPolicy,
  filterSources,
  stripDisallowedLinks,
  stripWrongLanguageLinks,
  ensureInternalLinks,
  LINK_POLICY_FACT_KEYS,
  type Lang,
} from "../lib/linkGuard";

/** Image 429 is quota, not a blip — do not retry it. */
const IMAGE_RETRY_STATUSES = [500, 502, 503, 504];

function isImageQuota(err: unknown) {
  const status = (err as { status?: number }).status;
  const msg = err instanceof Error ? err.message : String(err);
  return status === 429 || /429|quota|rate limit|RESOURCE_EXHAUSTED/i.test(msg);
}

export type GeneratedArticle = {
  title: string;
  bodyHtml: string;
  focusKeyword: string;
  seoTitle: string;
  metaDescription: string;
  slug?: string;
  schemaJson: Prisma.InputJsonValue;
  provider: string;
  model: string;
  imagePrompt?: string;
};

export type StageUpdate = {
  stage: "researching" | "writing" | "saving";
  label: string;
  pct?: number;
  /** Allow the bar to move backwards (new attempt / new model starts over). */
  reset?: boolean;
};

export type GenerateOptions = {
  brief?: string;
  provider?: "openai" | "gemini" | "auto";
  withImage?: boolean;
  onStage?: (stage: StageUpdate) => void;
};

const SYSTEM_JSON = `You are an expert SEO blog writer and editor for a business blog. You write clear, practical, plain-spoken articles that help the reader decide and act — not travel-magazine prose and not a thin AI outline.

Return ONLY valid JSON with keys:
title, bodyHtml, focusKeyword, seoTitle, metaDescription, slug, schemaJson (BlogPosting), imagePrompt (vivid English photo brief).

WRITING STANDARD — mandatory:
- TONE comes from the brief. If the brief contains tone/style guidelines they are BINDING and override every other style hint in this prompt. Default when the brief says nothing: simple, casual, clear, informative, practical.
- Write like a knowledgeable local explaining things to a friend: short plain sentences, concrete details (steps, options, what to ask, what to expect) instead of imagery. Natural, not stiff, not salesy.
- FORBIDDEN style: poetic, romantic, dreamy, dramatic or hype language; metaphors and similes; scene-setting openings ("Imagine…", "Picture this…", "There's something magical about…", "Step aboard…"). Never use words like: tapestry, nestled, embark, unforgettable, magical, dreamy, breathtaking, sun-kissed, whisper, symphony, journey (as a metaphor), ultimate, unparalleled, "golden hour".
- Opening: the first paragraph states plainly what the article covers and what the reader will get — a direct, practical statement or question. No atmosphere, no storytelling.
- Longform: 1,400–2,200+ words in bodyHtml, filled with useful concrete detail rather than ornament. Deep sections, not bullet dumps alone.
- bodyHtml MUST start with a short summary paragraph (2–3 plain sentences that give the answer in brief and contain the exact focusKeyword), written as <p class="post-summary">…</p>, BEFORE any heading. After it comes the full article. Do NOT include an <h1> (the page title is added separately).
- Semantic HTML only: h2/h3, p, ul/ol, blockquote when it fits, optional short FAQ.
- Locale: fully idiomatic in the requested language (en/pt/fr).
- Facts: do NOT invent prices, guarantees, licenses, phone numbers, or business claims not in the brief.
- imagePrompt: English photo brief for a REAL-looking featured image — natural light, documentary/lifestyle. Never “AI art”.

RANK MATH — exact-phrase tests (this is how the plugin scores 0–100):
- focusKeyword: 2–4 words, lowercase, the exact phrase you will repeat. Not a long sentence.
- Use that EXACT phrase (same words, same order) in: seoTitle (start with it), metaDescription, first <p>, at least one <h2>, and naturally 4–8 more times in body (density ~1%, never stuff).
- seoTitle: 50–60 characters, unique, starts with focusKeyword.
- metaDescription: 140–160 characters, includes focusKeyword once.
- slug: kebab-case of focusKeyword only (e.g. family-yacht-charter-lisbon).
- First 100 words of bodyHtml must include focusKeyword.
- Internal links: choose 3–5 <a href> links from site.linkTargets, but ONLY pages that are topically relevant to this article and genuinely useful to its reader (same subject or a natural next step). Skip targets about a different service or audience, even if that means fewer than 3 links. Never invent URLs and never link to another language's pages.
- External links: only if site.linkPolicy.externalLinks is true, at most 1, to an authoritative non-commercial source (government, tourism board, regulator, Wikipedia). NEVER link to, or recommend by name, any domain in site.linkPolicy.blockedDomains or any business that competes with this site (other charter/rental/service companies in the same niche). If in doubt, do not link out.
- Do not skip the keyword because a fancier synonym “sounds better” — Rank Math only counts the exact string.

STRUCTURE VARIETY — critical (do NOT reuse a template):
- Every article must feel uniquely shaped for THIS site + topic. Never copy a fixed skeleton like Hook → Overview → Tips → FAQ → CTA for every post.
- Pick a fresh angle and outline each time (examples to rotate among — invent others too): myth-busting; comparison; seasonal or occasion playbook; checklist-led practical guide; question-and-answer guide; mistake autopsy; local insider tips; decision framework.
- Vary section count, heading voice, whether FAQ appears, whether lists appear early or late, opening device (direct statement / practical question / concrete fact — never a scene or anecdote).
- Match voice to the site context when provided (yacht charter luxury leisure ≠ corporate renovation blog). Same platform, different souls.
- If brief/site notes exist, let them bend tone and structure.

Reject thin or formulaic content.`;

function userPayload(
  title: string,
  language: string,
  brief?: string,
  site?: {
    name?: string;
    baseUrl?: string;
    category?: string | null;
    businessFacts?: Array<{ key: string; value: string }>;
    linkTargets?: Array<{ title: string; url: string }>;
    linkPolicy?: { blockedDomains: string[]; externalLinks: boolean };
  },
  research?: {
    provider: string;
    answers: string[];
    sources: Array<{ title: string; url: string; snippet: string }>;
  } | null,
) {
  const shapes = [
    "step-by-step practical guide",
    "myth-busting expert teardown",
    "comparison / decision framework",
    "seasonal or occasion planning checklist",
    "insider local tips",
    "mistake autopsy + fixes",
    "question-and-answer guide",
    "options and what-to-ask explainer",
  ];
  const shape = shapes[Math.floor(Math.random() * shapes.length)];

  return JSON.stringify({
    title,
    language,
    brief: brief ?? null,
    briefInstruction: brief
      ? "The brief is binding. Follow its tone and style rules strictly; if they conflict with any default style guidance, the brief wins."
      : null,
    site: site
      ? {
          name: site.name ?? null,
          url: site.baseUrl ?? null,
          category: site.category ?? null,
          businessFacts: site.businessFacts?.length ? site.businessFacts : null,
          linkTargets: site.linkTargets?.length ? site.linkTargets : null,
          linkPolicy: site.linkPolicy ?? null,
          factsInstruction:
            "Use ONLY these approved business facts. Never invent prices, phones, licenses, guarantees, or services not listed.",
          linkingInstruction:
            "linkTargets are ranked by topical relevance. Insert contextual <a href> links (aim for 3–5) ONLY to targets that match this article's topic and help its reader; skip any that are about a different service or audience. Use natural, varied anchor text. Do not dump a link list and never add a link just to reach a count.",
        }
      : null,
    research: research
      ? {
          provider: research.provider,
          answers: research.answers,
          sources: research.sources,
          instruction:
            "Use research for accuracy and FAQ angles. Do not invent business facts. Cite ideas, not raw URLs in body unless natural.",
        }
      : null,
    requirements: {
      minWords: 1400,
      tone: "plain, casual, clear, informative — follow the brief's tone rules exactly; no poetic or dramatic language",
      depth: "expert, practical, concrete",
      structuralDirection: shape,
      uniqueness:
        "Invent a structure that fits this site and topic; do not reuse a generic template.",
    },
  });
}

function keywordSlug(keyword: string, title: string) {
  const raw = (keyword || title || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return raw || undefined;
}

function stubArticle(title: string, language: string): GeneratedArticle {
  return {
    title,
    bodyHtml: `<h1>${title}</h1><p>Stub — no live LLM key used.</p>`,
    focusKeyword: title.toLowerCase().slice(0, 60),
    seoTitle: `${title} | Guide`,
    metaDescription: `Learn about ${title}.`,
    slug: keywordSlug(title, title),
    schemaJson: {
      "@context": "https://schema.org",
      "@type": "BlogPosting",
      headline: title,
      inLanguage: language,
    },
    provider: "stub",
    model: "local-stub",
    imagePrompt: `Natural documentary photo for: ${title}. Real people/places if relevant, soft natural light, no AI-art look.`,
  };
}

function parseArticleJson(raw: string): GeneratedArticle {
  const cleaned = raw
    .replace(/^```json\s*/i, "")
    .replace(/```$/i, "")
    .trim();
  return JSON.parse(cleaned) as GeneratedArticle;
}

type SiteCtx = {
  name?: string;
  baseUrl?: string;
  category?: string | null;
  businessFacts?: Array<{ key: string; value: string }>;
  linkTargets?: Array<{ title: string; url: string }>;
  linkPolicy?: { blockedDomains: string[]; externalLinks: boolean };
};
type ResearchCtx = {
  provider: string;
  answers: string[];
  sources: Array<{ title: string; url: string; snippet: string }>;
};
type OnStage = GenerateOptions["onStage"];

const WRITE_PCT_START = 40;
const WRITE_PCT_SPAN = 45;

function writingPct(chars: number) {
  return WRITE_PCT_START + Math.min(WRITE_PCT_SPAN, Math.floor(chars / 90));
}

async function consumeSse(res: Response, onEvent: (payload: string) => void) {
  if (!res.body) {
    const text = await res.text();
    if (text) onEvent(text);
    return;
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (trimmed.startsWith("data:")) {
        const data = trimmed.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        onEvent(data);
      } else if (trimmed.startsWith("{")) {
        onEvent(trimmed);
      }
    }
  }
}

async function openaiArticle(
  title: string,
  language: string,
  brief?: string,
  site?: SiteCtx,
  research?: ResearchCtx | null,
  onStage?: OnStage,
) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return null;

  const requestedModel = process.env.OPENAI_MODEL ?? "gpt-4o";

  const res = await withRetry(
    () =>
      fetchWithStatus(
        "https://api.openai.com/v1/chat/completions",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${key}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: requestedModel,
            response_format: { type: "json_object" },
            temperature: 0.6,
            max_tokens: 8000,
            stream: true,
            messages: [
              { role: "system", content: SYSTEM_JSON },
              {
                role: "user",
                content: userPayload(title, language, brief, site, research),
              },
            ],
          }),
        },
        (status, text) => providerHttpError("OpenAI", status, text),
      ),
    {
      attempts: 3,
      baseDelayMs: 1000,
      label: "OpenAI generateContent",
      onAttempt: (attempt, attempts) =>
        onStage?.({
          stage: "writing",
          label:
            attempt === 1
              ? `Trying ${requestedModel}…`
              : `${requestedModel} unavailable — retry ${attempt}/${attempts}…`,
          pct: WRITE_PCT_START,
          reset: true,
        }),
    },
  );

  let raw = "";
  let writing = false;
  let lastBump = 0;
  let usage: { prompt_tokens?: number; completion_tokens?: number } | undefined;
  let model = requestedModel;

  await consumeSse(res, (payload) => {
    let chunk: {
      choices?: Array<{ delta?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
      model?: string;
    };
    try {
      chunk = JSON.parse(payload);
    } catch {
      return;
    }
    const delta = chunk.choices?.[0]?.delta?.content;
    if (delta) {
      raw += delta;
      const now = Date.now();
      if (!writing) {
        writing = true;
        lastBump = now;
        onStage?.({
          stage: "writing",
          label: `Writing with ${requestedModel}…`,
          pct: WRITE_PCT_START,
          reset: true,
        });
      } else if (now - lastBump >= 700) {
        lastBump = now;
        onStage?.({
          stage: "writing",
          label: `Writing with ${requestedModel}…`,
          pct: writingPct(raw.length),
        });
      }
    }
    if (chunk.usage) usage = chunk.usage;
    if (chunk.model) model = chunk.model;
  });

  if (!raw) throw new Error("OpenAI returned empty content");
  const parsed = parseArticleJson(raw);

  return {
    article: {
      ...parsed,
      provider: "openai",
      model,
    },
    usage,
  };
}

async function geminiArticle(
  title: string,
  language: string,
  brief?: string,
  site?: SiteCtx,
  research?: ResearchCtx | null,
  onStage?: OnStage,
) {
  const key = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!key) return null;

  // Try the preferred model first, then fall back to other known-good models
  // if it's overloaded (503) or rate-limited (429). Google rotates which
  // models are under heavy load, so a fallback list is more reliable than
  // pinning one model.
  const models = [
    process.env.GEMINI_MODEL,
    "gemini-3.8-flash",
    "gemini-3.7-flash",
    "gemini-3.6-flash",
    "gemini-3.5-flash",
    "gemini-flash-latest",
  ].filter((m, i, a): m is string => Boolean(m) && a.indexOf(m) === i);

  const modelErrors: string[] = [];

  for (let mi = 0; mi < models.length; mi++) {
    const model = models[mi];
    const nextModel = models[mi + 1];
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${encodeURIComponent(key)}`;

    try {
      const res = await withRetry(
        () =>
          fetchWithStatus(
            url,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                contents: [
                  {
                    role: "user",
                    parts: [
                      {
                        text: `${SYSTEM_JSON}\n\nInput:\n${userPayload(title, language, brief, site, research)}`,
                      },
                    ],
                  },
                ],
                generationConfig: {
                  responseMimeType: "application/json",
                  temperature: 0.6,
                  // Thinking models count reasoning tokens against this budget;
                  // 8192 can truncate the JSON mid-stream.
                  maxOutputTokens: 16384,
                },
              }),
            },
            (status, text) => providerHttpError("Gemini", status, text),
          ),
        {
          attempts: 4,
          baseDelayMs: 4000,
          label: `Gemini ${model}`,
          onAttempt: (attempt, attempts) =>
            onStage?.({
              stage: "writing",
              label:
                attempt === 1
                  ? `Trying ${model}…`
                  : `${model} unavailable — retry ${attempt}/${attempts}…`,
              pct: WRITE_PCT_START,
              reset: true,
            }),
        },
      );

      let raw = "";
      let writing = false;
      let lastBump = 0;
      let usage:
        | { prompt_tokens?: number; completion_tokens?: number }
        | undefined;

      await consumeSse(res, (payload) => {
        let chunk: {
          candidates?: Array<{
            content?: { parts?: Array<{ text?: string }> };
          }>;
          usageMetadata?: {
            promptTokenCount?: number;
            candidatesTokenCount?: number;
          };
        };
        try {
          chunk = JSON.parse(payload);
        } catch {
          return;
        }
        const piece =
          chunk.candidates?.[0]?.content?.parts
            ?.map((p) => p.text ?? "")
            .join("") ?? "";
        if (piece) {
          raw += piece;
          const now = Date.now();
          if (!writing) {
            writing = true;
            lastBump = now;
            onStage?.({
              stage: "writing",
              label: `Writing with ${model}…`,
              pct: WRITE_PCT_START,
              reset: true,
            });
          } else if (now - lastBump >= 700) {
            lastBump = now;
            onStage?.({
              stage: "writing",
              label: `Writing with ${model}…`,
              pct: writingPct(raw.length),
            });
          }
        }
        if (chunk.usageMetadata) {
          usage = {
            prompt_tokens: chunk.usageMetadata.promptTokenCount,
            completion_tokens: chunk.usageMetadata.candidatesTokenCount,
          };
        }
      });

      if (!raw) throw new Error("Gemini returned empty content");
      const parsed = parseArticleJson(raw);

      return {
        article: {
          ...parsed,
          provider: "gemini",
          model,
        },
        usage: usage ?? {},
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[gemini:${model}] failed:`, msg);
      modelErrors.push(`${model}: ${msg}`);
      onStage?.({
        stage: "writing",
        label: nextModel
          ? `${model} failed — trying ${nextModel}…`
          : `${model} failed`,
        pct: WRITE_PCT_START,
        reset: true,
      });
    }
  }

  throw new Error(modelErrors.join(" | ") || "Gemini: all models failed");
}

function naturalPhotoPrompt(prompt: string) {
  const base = prompt.trim().slice(0, 900);
  return [
    base,
    "Style: photorealistic natural photography as if shot on a full-frame camera by a travel photographer.",
    "Natural skin texture, real lighting, authentic environment, slight grain OK.",
    "Avoid: AI-art look, plastic skin, oversharpening, fake HDR, watermarks, text overlays, logos, CGI, illustration.",
    "Aspect: landscape 16:9 suitable as a WordPress featured image.",
  ].join(" ");
}

/** Featured image — OpenAI first, Gemini native image as fallback */
export async function generateFeaturedImageBytes(
  prompt: string,
  onStage?: (stage: { pct?: number; label: string }) => void,
): Promise<{
  bytes: Buffer;
  mime: string;
  provider: string;
  model: string;
} | null> {
  const errors: string[] = [];
  const fullPrompt = naturalPhotoPrompt(prompt);

  onStage?.({ pct: 18, label: "Checking image keys…" });
  const cap = await probeImageCapability();

  const openaiKey = process.env.OPENAI_API_KEY;
  const geminiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!openaiKey && !geminiKey) {
    throw new Error(
      "No image API keys set. Add OpenAI or Gemini under Maintenance.",
    );
  }

  const openaiModels = [
    process.env.OPENAI_IMAGE_MODEL,
    ...cap.openai.models,
    "gpt-image-1",
    "dall-e-3",
    "dall-e-2",
  ].filter((m, i, a): m is string => Boolean(m) && a.indexOf(m) === i);

  if (openaiKey) {
    for (let i = 0; i < openaiModels.length; i++) {
      const model = openaiModels[i];
      const last = i === openaiModels.length - 1;
      try {
        const payload: Record<string, unknown> = {
          model,
          prompt: fullPrompt.slice(0, 1000),
          n: 1,
        };
        if (model.includes("dall-e")) {
          payload.size = model.includes("dall-e-3") ? "1792x1024" : "1024x1024";
        } else {
          payload.size = "1024x1024";
        }

        const res = await withRetry(
          () =>
            fetchWithStatus(
              "https://api.openai.com/v1/images/generations",
              {
                method: "POST",
                headers: {
                  Authorization: `Bearer ${openaiKey}`,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify(payload),
              },
              (status, text) => providerHttpError("OpenAI image", status, text),
            ),
          {
            attempts: 2,
            baseDelayMs: 1000,
            retryStatuses: IMAGE_RETRY_STATUSES,
            label: "OpenAI image generation",
            onAttempt: (n, total) =>
              onStage?.({
                label:
                  n === 1
                    ? `Trying ${model} for the featured image…`
                    : `${model} unavailable — retry ${n}/${total}…`,
              }),
          },
        );
        const data = (await res.json()) as {
          data?: Array<{ b64_json?: string; url?: string }>;
        };
        const item = data.data?.[0];
        if (item?.b64_json) {
          return {
            bytes: Buffer.from(item.b64_json, "base64"),
            mime: "image/png",
            provider: "openai",
            model,
          };
        }
        if (item?.url) {
          const imgRes = await fetch(item.url);
          if (!imgRes.ok)
            throw new Error(`OpenAI image download ${imgRes.status}`);
          const buf = Buffer.from(await imgRes.arrayBuffer());
          return { bytes: buf, mime: "image/png", provider: "openai", model };
        }
        throw new Error("OpenAI image empty");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(msg);
        onStage?.({
          label: last
            ? geminiKey
              ? `${model} failed — trying Gemini…`
              : `${model} failed`
            : `${model} failed — trying ${openaiModels[i + 1]}…`,
        });
        if (isImageQuota(err)) break;
      }
    }
  }

  if (geminiKey) {
    const models = [
      process.env.GEMINI_IMAGE_MODEL,
      ...cap.gemini.models,
      "gemini-3.1-flash-image",
      "gemini-2.5-flash-image",
      "imagen-4.0-generate-001",
    ].filter((m, i, a): m is string => Boolean(m) && a.indexOf(m) === i);

    for (let i = 0; i < models.length; i++) {
      const model = models[i];
      const last = i === models.length - 1;
      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(geminiKey)}`;
        const res = await withRetry(
          () =>
            fetchWithStatus(
              url,
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  contents: [{ role: "user", parts: [{ text: fullPrompt }] }],
                  generationConfig: {
                    responseModalities: ["TEXT", "IMAGE"],
                  },
                }),
              },
              (status, text) => providerHttpError("Gemini image", status, text),
            ),
          {
            attempts: 2,
            baseDelayMs: 1000,
            retryStatuses: IMAGE_RETRY_STATUSES,
            label: "Gemini image",
            onAttempt: (n, total) =>
              onStage?.({
                label:
                  n === 1
                    ? `Trying ${model} for the featured image…`
                    : `${model} unavailable — retry ${n}/${total}…`,
              }),
          },
        );
        const data = (await res.json()) as {
          candidates?: Array<{
            content?: {
              parts?: Array<{
                inlineData?: { mimeType?: string; data?: string };
                inline_data?: { mime_type?: string; data?: string };
              }>;
            };
          }>;
        };
        const parts = data.candidates?.[0]?.content?.parts ?? [];
        for (const part of parts) {
          const inline = part.inlineData ?? part.inline_data;
          const b64 = inline?.data;
          const mime =
            ("mimeType" in (inline ?? {})
              ? (inline as { mimeType?: string }).mimeType
              : (inline as { mime_type?: string } | undefined)?.mime_type) ??
            "image/png";
          if (b64) {
            return {
              bytes: Buffer.from(b64, "base64"),
              mime,
              provider: "gemini",
              model,
            };
          }
        }
        throw new Error("Gemini image empty (no inline image part)");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(msg);
        onStage?.({
          label: last
            ? `${model} failed`
            : `${model} failed — trying ${models[i + 1]}…`,
        });
        if (isImageQuota(err)) break;
      }
    }
  }

  if (errors.length) {
    throw new Error(errors.join(" · "));
  }
  return null;
}

export async function generateForContent(
  contentId: string,
  options: GenerateOptions = {},
) {
  const content = await prisma.contentItem.findUnique({
    where: { id: contentId },
    include: { site: true, category: true },
  });
  if (!content) throw new Error("Content not found");

  const lang = content.language;
  const prefer = options.provider ?? "auto";

  options.onStage?.({
    stage: "researching",
    label: "Loading site context…",
    pct: 5,
  });

  const [facts, rankedLinks] = await Promise.all([
    prisma.businessFact.findMany({
      where: { siteId: content.siteId },
      orderBy: { key: "asc" },
      take: 40,
    }),
    rankLinkTargets(
      content.siteId,
      content.title,
      content.focusKeyword ? [content.focusKeyword] : [],
      {
        limit: 15,
        excludeContentId: content.id,
        language: lang as Lang,
        minResults: 3,
      },
    ),
  ]);

  const linkPolicy = buildLinkPolicy(content.site.baseUrl, facts);

  const siteCtx: SiteCtx = {
    name: content.site.name,
    baseUrl: content.site.baseUrl,
    category: content.category?.name ?? null,
    businessFacts: facts
      .filter((f) => !LINK_POLICY_FACT_KEYS.includes(f.key.trim().toLowerCase()))
      .map((f) => ({ key: f.key, value: f.value })),
    linkPolicy: {
      blockedDomains: linkPolicy.blocked,
      externalLinks: linkPolicy.allowExternal,
    },
    linkTargets: rankedLinks.map((p) => ({ title: p.title, url: p.url })),
  };

  options.onStage?.({
    stage: "researching",
    label: "Researching topic…",
    pct: 10,
  });

  let research: ResearchCtx | null = null;
  let researchError: string | undefined;
  try {
    const packet = await researchTopic({
      title: content.title,
      language: lang,
      siteName: content.site.name,
      category: content.category?.name,
      brief: options.brief,
    });
    if (packet) {
      research = {
        provider: packet.provider,
        answers: packet.answers,
        sources: filterSources(packet.sources, linkPolicy),
      };
      await prisma.aiUsage.create({
        data: {
          contentId: content.id,
          provider: "tavily",
          model: "search",
          operation: "research",
          estimatedUsd: estimateUsd({
            provider: "tavily",
            model: "search",
            operation: "research",
          }),
        },
      });
    }
  } catch (err) {
    researchError = err instanceof Error ? err.message : String(err);
  }

  options.onStage?.({ stage: "writing", label: "Starting draft…", pct: 20 });

  let article: GeneratedArticle;
  let usage: { prompt_tokens?: number; completion_tokens?: number } | undefined;
  let fallbackFrom: string | undefined;

  const hasOpenAI = Boolean(process.env.OPENAI_API_KEY);
  const hasGemini = Boolean(
    process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY,
  );

  const order: Array<"openai" | "gemini"> = [];
  if (prefer === "gemini") {
    if (hasGemini) order.push("gemini");
    if (hasOpenAI) order.push("openai");
  } else if (prefer === "openai") {
    if (hasOpenAI) order.push("openai");
    if (hasGemini) order.push("gemini");
  } else {
    // auto: OpenAI first, Gemini backup (and reverse if only one key exists)
    if (hasOpenAI) order.push("openai");
    if (hasGemini) order.push("gemini");
  }

  const providerErrors: string[] = [];
  let live: Awaited<ReturnType<typeof openaiArticle>> = null;

  for (let i = 0; i < order.length; i++) {
    const provider = order[i];
    const name = provider === "openai" ? "OpenAI" : "Gemini";
    const next = order[i + 1];
    try {
      live =
        provider === "openai"
          ? await openaiArticle(
              content.title,
              lang,
              options.brief,
              siteCtx,
              research,
              options.onStage,
            )
          : await geminiArticle(
              content.title,
              lang,
              options.brief,
              siteCtx,
              research,
              options.onStage,
            );
      if (providerErrors.length > 0) {
        fallbackFrom = providerErrors[0]?.startsWith("OpenAI")
          ? "openai"
          : providerErrors[0]?.startsWith("Gemini")
            ? "gemini"
            : order[0];
      }
      break;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      providerErrors.push(msg);
      live = null;
      if (next) {
        options.onStage?.({
          stage: "writing",
          label: `${name} failed — trying ${next === "openai" ? "OpenAI" : "Gemini"}…`,
          pct: WRITE_PCT_START,
          reset: true,
        });
      }
    }
  }

  if (live) {
    article = live.article;
    usage = live.usage;
    if (article.bodyHtml) {
      const guarded = stripDisallowedLinks(article.bodyHtml, linkPolicy);
      if (guarded.removed.length) {
        console.warn("[linkGuard] removed links:", guarded.removed.join(", "));
      }
      const sameLang = stripWrongLanguageLinks(guarded.html, linkPolicy.siteHost, lang as Lang);
      const ensured = ensureInternalLinks(
        sameLang.html,
        siteCtx.linkTargets ?? [],
        3,
        lang as Lang,
        linkPolicy.siteHost,
      );
      article.bodyHtml = ensured.html;
    }
  } else if (order.length === 0) {
    article = stubArticle(content.title, lang);
  } else {
    const summary = providerErrors.slice(0, 2).join(" · ");
    throw new Error(
      summary
        ? `All AI providers failed. ${summary}`
        : "All AI providers failed. Please try Generate again in a minute.",
    );
  }

  options.onStage?.({ stage: "saving", label: "Saving draft…", pct: 90 });

  const updated = await prisma.contentItem.update({
    where: { id: content.id },
    data: {
      title: article.title || content.title,
      bodyHtml: article.bodyHtml,
      slug:
        article.slug ||
        keywordSlug(article.focusKeyword, article.title || content.title) ||
        undefined,
      focusKeyword: article.focusKeyword,
      seoTitle: article.seoTitle,
      metaDescription: article.metaDescription,
      schemaJson: article.schemaJson,
      status: "HUMAN_REVIEW",
    },
  });

  if (article.bodyHtml) {
    await recordAppliedLinks(
      content.siteId,
      "content",
      content.id,
      article.bodyHtml,
    );
  }

  const estimatedUsd = estimateUsd({
    provider: article.provider,
    model: article.model,
    inputTokens: usage?.prompt_tokens,
    outputTokens: usage?.completion_tokens,
    operation: "generate_article",
  });

  await prisma.aiUsage.create({
    data: {
      contentId: content.id,
      provider: article.provider,
      model: article.model,
      operation: "generate_article",
      inputTokens: usage?.prompt_tokens,
      outputTokens: usage?.completion_tokens,
      estimatedUsd,
    },
  });

  let hasFeaturedImage = false;
  if (options.withImage !== false) {
    options.onStage?.({
      stage: "saving",
      label: "Trying featured image…",
      pct: 92,
    });
    try {
      const img = await generateFeaturedImageBytes(
        article.imagePrompt ?? `Natural lifestyle photo for: ${article.title}`,
        (s) =>
          options.onStage?.({
            stage: "saving",
            label: s.label,
            pct: s.pct ?? 92,
          }),
      );
      if (img) {
        saveFeaturedImage(content.id, img.bytes);
        hasFeaturedImage = true;
        await prisma.aiUsage.create({
          data: {
            contentId: content.id,
            provider: img.provider,
            model: img.model,
            operation: "generate_image",
            estimatedUsd: img.provider === "openai" ? 0.04 : 0.02,
          },
        });
      }
    } catch {
      /* article still saved */
    }
  }

  return {
    content: updated,
    provider: article.provider,
    fallbackFrom: fallbackFrom || null,
    research: research
      ? { provider: research.provider, sources: research.sources.length }
      : null,
    researchError,
    hasFeaturedImage,
    imagePrompt: article.imagePrompt ?? `Featured image for: ${article.title}`,
    usage: {
      inputTokens: usage?.prompt_tokens ?? null,
      outputTokens: usage?.completion_tokens ?? null,
      estimatedUsd,
      estimatedUsdLabel: formatUsdLabel(estimatedUsd),
    },
  };
}

function formatUsdLabel(n: number) {
  if (n > 0 && n < 0.01) return `~$${n.toFixed(4)}`;
  return `~$${n.toFixed(3)}`;
}
