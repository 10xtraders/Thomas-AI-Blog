import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import {
  generateFeaturedImageBytes,
  generateForContent,
} from "../services/generate";
import { siteWpAuth } from "../lib/siteAuth";
import { createJob, updateJob, finishJob, failJob, getJob } from "../lib/jobs";
import {
  hasFeaturedImage as featuredOnDisk,
  readFeaturedImage,
  saveFeaturedImage,
} from "../lib/featuredStore";
import {
  createWpCategory,
  createWpDraftPost,
  deleteWpPost,
  uploadWpMedia,
  verifyRankMathMeta,
} from "../services/wordpress";
import { localizeContent } from "../services/localize";
import { optimizeForWeb } from "../lib/imageOptimize";
import { inlineFigure } from "../lib/inLineImage";
import { proposeOptimization } from "../services/optimize";

type PublishOpts = {
  withImage?: boolean;
  imagePrompt?: string;
  status?: "draft" | "publish";
};

async function runPublish(
  id: string,
  body: PublishOpts,
  onStage: (s: { pct?: number; label: string }) => void,
) {
  const content = await prisma.contentItem.findUnique({
    where: { id },
    include: { site: true, category: true },
  });
  if (!content) throw new Error("Not found");
  if (content.status !== "APPROVED" && content.status !== "HUMAN_REVIEW") {
    throw new Error("Content must be reviewed/approved before publish");
  }
  if (!content.bodyHtml) throw new Error("No body to publish");
  if (content.wpPostId) {
    return {
      content,
      alreadyPublished: true,
      imageError: undefined as string | undefined,
    };
  }

  const categories =
    content.category?.wpCategoryId != null
      ? [content.category.wpCategoryId]
      : [];
  // Page order the client asked for: H1 -> main image -> summary paragraph -> full text.
  // Switch the H1 off per site with the business fact:  h1_in_content: off
  const h1Fact = await prisma.businessFact.findFirst({
    where: { siteId: content.site.id, key: "h1_in_content" },
  });
  const withH1 = !(h1Fact && /^(off|no|false|none)$/i.test(h1Fact.value.trim()));
  // Themes that already show the featured image above the post switch the copy in the body off:
  // image_in_content: off
  const imageFact = await prisma.businessFact.findFirst({
    where: { siteId: content.site.id, key: "image_in_content" },
  });
  const withInlineImage = !(imageFact && /^(off|no|false|none)$/i.test(imageFact.value.trim()));
  const escHtml = (t: string) =>
    t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  let heroFigure = "";

  let html = [
    content.bodyHtml.replace(/<h1\b[\s\S]*?<\/h1>\s*/gi, ""),
    content.schemaJson
      ? `<script type="application/ld+json">${JSON.stringify(content.schemaJson)}</script>`
      : "",
  ]
    .filter(Boolean)
    .join("\n");

  let featuredMediaId: number | undefined;
  let media: { id: number; source_url?: string } | undefined;
  let imageError: string | undefined;
  const auth = await siteWpAuth(content.site);

  if (body.withImage !== false) {
    const prompt =
      body.imagePrompt ??
      `Natural lifestyle photo for WordPress featured image about: ${content.title}. Real scene, natural light, documentary look.`;
    try {
      const stored = readFeaturedImage(id);
      const img = stored
        ? {
            bytes: stored,
            mime: "image/png",
            provider: "stored",
            model: "featured",
          }
        : await generateFeaturedImageBytes(prompt, onStage);
      if (img) {
        if (!stored) saveFeaturedImage(id, img.bytes);
        onStage({ pct: 76, label: "Optimizing image…" });
        const web = await optimizeForWeb(img.bytes, img.mime);
        onStage({ pct: 78, label: "Uploading image to WordPress…" });
        media = await uploadWpMedia(
          auth.baseUrl,
          auth.username,
          auth.appPassword,
          {
            bytes: web.bytes,
            filename: `${content.slug || "featured"}-${Date.now()}.${web.ext}`,
            mime: web.mime,
            alt: content.focusKeyword || content.title,
            title: content.title,
          },
        );
        featuredMediaId = media.id;
        onStage({ pct: 88, label: "Image uploaded to WordPress" });
        if (img.provider !== "stored") {
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
      }
    } catch (err) {
      imageError = err instanceof Error ? err.message : String(err);
      onStage({ label: "Skipping image — continuing to WordPress" });
    }
  } else {
    onStage({ pct: 70, label: "Skipping image (turned off)" });
  }

  // One image serves as both the featured image and the main post image (client brief, Oct 15):
  // a second generation only cost credits and showed two different pictures.
  if (withInlineImage && media?.source_url) {
    heroFigure = inlineFigure(media.source_url, content.focusKeyword || content.title);
  }

  if (body.withImage !== false && !featuredMediaId && !imageError) {
    imageError = "Featured image was not attached.";
  }

  onStage({ pct: 90, label: "Creating WordPress draft…" });
  const post = (await createWpDraftPost(
    auth.baseUrl,
    auth.username,
    auth.appPassword,
    {
      // The page title and the H1 are the same text; the SEO title stays in Rank Math.
      title: content.title,
      content: [
        withH1 ? `<h1>${escHtml(content.title)}</h1>` : "",
        heroFigure,
        html,
      ]
        .filter(Boolean)
        .join("\n"),
      categories,
      status: body.status ?? "draft",
      featuredMediaId,
      excerpt: content.metaDescription ?? undefined,
      slug: content.slug ?? undefined,
      seo: {
        focusKeyword: content.focusKeyword ?? undefined,
        seoTitle: content.seoTitle ?? undefined,
        metaDescription: content.metaDescription ?? undefined,
      },
    },
  )) as { id: number; link?: string };

  const updated = await prisma.contentItem.update({
    where: { id },
    data: {
      status: "PUBLISHED",
      wpPostId: post.id,
      wpUrl: post.link ?? null,
    },
  });

  let rankMath: { verified: boolean; mismatches: string[] } | null = null;
  try {
    onStage({ pct: 96, label: "Checking Rank Math fields…" });
    rankMath = await verifyRankMathMeta(
      auth.baseUrl,
      auth.username,
      auth.appPassword,
      post.id,
      {
        focusKeyword: content.focusKeyword ?? undefined,
        seoTitle: content.seoTitle ?? undefined,
        metaDescription: content.metaDescription ?? undefined,
      },
    );
    await prisma.contentItem.update({
      where: { id },
      data: {
        rankMathVerified: rankMath.verified,
        rankMathMismatches: rankMath.mismatches,
      },
    });
  } catch {
    /* Rank Math REST meta not registered */
  }

  onStage({
    pct: 99,
    label: featuredMediaId
      ? "Uploaded — finishing…"
      : "Draft created — finishing…",
  });
  return {
    content: {
      id: updated.id,
      title: updated.title,
      status: updated.status,
      wpUrl: updated.wpUrl,
      wpPostId: updated.wpPostId,
    },
    hasFeaturedImage: Boolean(featuredMediaId),
    featuredMediaId: featuredMediaId ?? null,
    imageError: imageError ?? null,
    rankMath,
  };
}

export const contentRoutes: FastifyPluginAsync = async (app) => {
  app.get("/", async (req) => {
    const q = z.object({ siteId: z.string().optional() }).parse(req.query);

    const contents = await prisma.contentItem.findMany({
      where: q.siteId ? { siteId: q.siteId } : undefined,
      orderBy: { updatedAt: "desc" },
      take: 50,
      include: {
        category: { select: { id: true, name: true, wpCategoryId: true } },
        site: { select: { id: true, name: true } },
      },
    });
    return {
      contents: contents.map((c) => ({
        ...c,
        hasFeaturedImage: featuredOnDisk(c.id),
      })),
    };
  });

  app.get("/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const content = await prisma.contentItem.findUnique({
      where: { id },
      include: {
        category: true,
        site: { select: { id: true, name: true, baseUrl: true } },
      },
    });
    if (!content) return reply.code(404).send({ error: "Not found" });
    return {
      content: { ...content, hasFeaturedImage: featuredOnDisk(content.id) },
    };
  });

  app.get("/:id/featured-image", async (req, reply) => {
    const { id } = req.params as { id: string };
    const bytes = readFeaturedImage(id);
    if (!bytes) return reply.code(404).send({ error: "No featured image" });
    return reply.type("image/png").send(bytes);
  });

  app.post("/", async (req, reply) => {
    const body = z
      .object({
        siteId: z.string().min(1),
        categoryId: z.string().optional(),
        customCategory: z.string().min(1).optional(),
        title: z.string().min(1),
        language: z.enum(["en", "pt", "fr"]).optional(),
      })
      .parse(req.body);

    const site = await prisma.site.findUnique({ where: { id: body.siteId } });
    if (!site) return reply.code(404).send({ error: "Site not found" });

    let categoryId = body.categoryId || undefined;

    if (body.customCategory?.trim()) {
      const name = body.customCategory.trim();
      const slug =
        name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "")
          .slice(0, 80) || `cat-${Date.now()}`;

      const existing = await prisma.category.findUnique({
        where: { siteId_slug: { siteId: site.id, slug } },
      });
      if (existing) {
        categoryId = existing.id;
      } else {
        try {
          const auth = await siteWpAuth(site);
          const wpCat = await createWpCategory(
            auth.baseUrl,
            auth.username,
            auth.appPassword,
            name,
          );
          const created = await prisma.category.create({
            data: {
              siteId: site.id,
              name: wpCat.name || name,
              slug: wpCat.slug || slug,
              wpCategoryId: wpCat.id,
            },
          });
          categoryId = created.id;
        } catch (err) {
          // still save locally if WP create fails
          const created = await prisma.category.create({
            data: {
              siteId: site.id,
              name,
              slug,
            },
          });
          categoryId = created.id;
          void err;
        }
      }
    }

    const content = await prisma.contentItem.create({
      data: {
        siteId: body.siteId,
        categoryId,
        title: body.title,
        language: body.language ?? "en",
        status: "IDEA",
      },
    });
    return reply.code(201).send({ content });
  });

  app.patch("/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z
      .object({
        title: z.string().min(1).optional(),
        bodyHtml: z.string().optional(),
        seoTitle: z.string().optional(),
        metaDescription: z.string().optional(),
        focusKeyword: z.string().optional(),
        language: z.enum(["en", "pt", "fr"]).optional(),
      })
      .parse(req.body ?? {});

    const existing = await prisma.contentItem.findUnique({ where: { id } });
    if (!existing) return reply.code(404).send({ error: "Not found" });

    if (existing.bodyHtml && (body.bodyHtml || body.title)) {
      await prisma.contentVersion.create({
        data: {
          contentId: id,
          title: existing.title,
          bodyHtml: existing.bodyHtml,
          seoTitle: existing.seoTitle,
          metaDescription: existing.metaDescription,
        },
      });
    }

    const content = await prisma.contentItem.update({
      where: { id },
      data: {
        ...body,
        status:
          existing.status === "PUBLISHED"
            ? "UPDATED"
            : body.bodyHtml
              ? "HUMAN_REVIEW"
              : existing.status,
      },
    });
    return { content };
  });

  // GET /content/:id/versions — history for the before/after review UI
  app.get("/:id/versions", async (req) => {
    const { id } = req.params as { id: string };
    const versions = await prisma.contentVersion.findMany({
      where: { contentId: id },
      orderBy: { createdAt: "desc" },
    });
    return { versions };
  });

  app.delete("/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const q = z
      .object({
        deleteWp: z
          .union([z.boolean(), z.enum(["true", "false", "1", "0"])])
          .optional()
          .transform((v) => v === true || v === "true" || v === "1"),
      })
      .parse(req.query ?? {});
    const body = z
      .object({ deleteWp: z.boolean().optional() })
      .safeParse(req.body ?? {});
    const deleteWp = q.deleteWp || Boolean(body.success && body.data.deleteWp);

    const existing = await prisma.contentItem.findUnique({
      where: { id },
      include: { site: true },
    });
    if (!existing) return reply.code(404).send({ error: "Not found" });

    let wpDeleted = false;
    if (deleteWp && existing.wpPostId) {
      try {
        const auth = await siteWpAuth(existing.site);
        await deleteWpPost(
          auth.baseUrl,
          auth.username,
          auth.appPassword,
          existing.wpPostId,
        );
        wpDeleted = true;
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "WordPress delete failed";
        return reply.code(400).send({ error: message });
      }
    }

    const hadWp = Boolean(existing.wpPostId || existing.wpUrl);
    const wpUrl = existing.wpUrl;
    await prisma.contentItem.delete({ where: { id } });
    return {
      ok: true,
      wpDeleted,
      hadWp,
      wpUrl: hadWp && !wpDeleted ? wpUrl : null,
    };
  });

  // Kicks off generation as a background job and returns immediately.
  // The frontend polls GET /:id/generate/status for real progress instead
  // of guessing with a fake timer.
  app.post("/:id/generate", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z
      .object({
        brief: z.string().optional(),
        provider: z.enum(["openai", "gemini", "auto"]).optional(),
        withImage: z.boolean().optional(),
      })
      .parse(req.body ?? {});

    const existingJob = await getJob(id);
    if (existingJob?.status === "running") {
      return reply
        .code(409)
        .send({ error: "Generation already in progress for this item" });
    }

    await createJob(id, "generate", id);

    generateForContent(id, {
      brief: body.brief,
      provider: body.provider ?? "auto",
      withImage: body.withImage,
      onStage: (stage) => {
        // void updateJob(id, { pct: stage.pct, label: stage.label });
        void updateJob(id, {
          pct: stage.pct,
          label: stage.label,
          reset: stage.reset,
        });
      },
    })
      .then((result) => finishJob(id, result))
      .catch((err) =>
        failJob(id, err instanceof Error ? err.message : String(err)),
      );

    return reply.code(202).send({ jobId: id, status: "running" });
  });

  app.get("/:id/generate/status", async (req, reply) => {
    const { id } = req.params as { id: string };
    const job = await getJob(id);
    if (!job || job.type !== "generate") {
      return reply.code(404).send({ error: "No generation job for this item" });
    }
    return job;
  });

  app.post("/:id/approve", async (req, reply) => {
    const { id } = req.params as { id: string };
    const content = await prisma.contentItem.findUnique({ where: { id } });
    if (!content) return reply.code(404).send({ error: "Not found" });
    if (!content.bodyHtml) {
      return reply.code(400).send({ error: "Generate content before approve" });
    }

    const updated = await prisma.contentItem.update({
      where: { id },
      data: { status: "APPROVED" },
    });
    return { content: updated };
  });

  app.post("/:id/reject", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z
      .object({ note: z.string().optional() })
      .parse(req.body ?? {});
    const content = await prisma.contentItem.findUnique({ where: { id } });
    if (!content) return reply.code(404).send({ error: "Not found" });
    const updated = await prisma.contentItem.update({
      where: { id },
      data: { status: "REJECTED", reviewNote: body.note ?? null },
    });
    return { content: updated };
  });

  app.post("/:id/request-changes", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z.object({ note: z.string().min(1) }).parse(req.body ?? {});
    const content = await prisma.contentItem.findUnique({ where: { id } });
    if (!content) return reply.code(404).send({ error: "Not found" });
    const updated = await prisma.contentItem.update({
      where: { id },
      data: { status: "NEEDS_REVISION", reviewNote: body.note },
    });
    return { content: updated };
  });

  app.post("/:id/publish", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z
      .object({
        withImage: z.boolean().optional(),
        imagePrompt: z.string().optional(),
        status: z.enum(["draft", "publish"]).optional(),
      })
      .parse(req.body ?? {});

    const content = await prisma.contentItem.findUnique({ where: { id } });
    if (!content) return reply.code(404).send({ error: "Not found" });
    if (content.status !== "APPROVED" && content.status !== "HUMAN_REVIEW") {
      return reply
        .code(400)
        .send({ error: "Content must be reviewed/approved before publish" });
    }
    if (!content.bodyHtml) {
      return reply.code(400).send({ error: "No body to publish" });
    }
    if (content.wpPostId) {
      return { content, alreadyPublished: true };
    }

    const existingJob = await getJob(id);
    if (existingJob?.status === "running") {
      return reply
        .code(409)
        .send({ error: "A job is already running for this item" });
    }

    await createJob(id, "publish", id);
    void updateJob(id, { pct: 8, label: "Starting publish…" });

    runPublish(id, body, (stage) => {
      void updateJob(id, { pct: stage.pct, label: stage.label });
    })
      .then((result) => finishJob(id, result))
      .catch((err) =>
        failJob(id, err instanceof Error ? err.message : String(err)),
      );

    return reply.code(202).send({ jobId: id, status: "running" });
  });

  app.get("/:id/publish/status", async (req, reply) => {
    const { id } = req.params as { id: string };
    const job = await getJob(id);
    if (!job || job.type !== "publish") {
      return reply.code(404).send({ error: "No publish job for this item" });
    }
    return job;
  });

  // POST /content/:id/localize  { languages: ["pt","fr"] }
  // Returns immediately; the browser polls /localize/status so a long
  // translation is not killed by the proxy as a network error.
  app.post("/:id/localize", async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z
      .object({ languages: z.array(z.enum(["pt", "fr"])).min(1) })
      .parse(req.body ?? {});

    const existingJob = await getJob(id);
    if (existingJob?.status === "running") {
      return reply
        .code(409)
        .send({ error: "A job is already running for this item" });
    }

    await createJob(id, "localize", id);
    void updateJob(id, { pct: 8, label: "Starting translation…" });

    localizeContent(id, body.languages, (stage) => {
      void updateJob(id, { pct: stage.pct, label: stage.label });
    })
      .then((children) => finishJob(id, { children }))
      .catch((err) =>
        failJob(id, err instanceof Error ? err.message : String(err)),
      );

    return reply.code(202).send({ jobId: id, status: "running" });
  });

  app.get("/:id/localize/status", async (req, reply) => {
    const { id } = req.params as { id: string };
    const job = await getJob(id);
    if (!job || job.type !== "localize") {
      return reply
        .code(404)
        .send({ error: "No localization job for this item" });
    }
    return job;
  });

  // POST /content/:id/optimize — analyze live WP page, propose an update as NEEDS_REVISION
  app.post("/:id/optimize", async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const result = await proposeOptimization(id);
      return result;
    } catch (err) {
      return reply.code(502).send({
        error: err instanceof Error ? err.message : "Optimization failed",
      });
    }
  });
};
