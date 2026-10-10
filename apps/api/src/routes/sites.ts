import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { encryptSecret } from "../lib/secrets";
import { syncCategories } from "../services/scanner";

const createSiteSchema = z.object({
  name: z.string().min(1),
  baseUrl: z.string().url(),
  wpUsername: z.string().min(1),
  wpAppPassword: z.string().min(1),
  rankMathActive: z.boolean().optional(),
});

export const siteRoutes: FastifyPluginAsync = async (app) => {
  app.get("/", async () => {
    const sites = await prisma.site.findMany({
      select: {
        id: true,
        name: true,
        baseUrl: true,
        rankMathActive: true,
        createdAt: true,
        _count: { select: { categories: true, contents: true } },
      },
      orderBy: { createdAt: "desc" },
    });
    return { sites };
  });

  app.post("/", async (req, reply) => {
    const body = createSiteSchema.parse(req.body);
    const site = await prisma.site.create({
      data: {
        name: body.name,
        baseUrl: body.baseUrl.replace(/\/$/, ""),
        wpUsername: body.wpUsername,
        wpAppPassword: encryptSecret(body.wpAppPassword),
        rankMathActive: body.rankMathActive ?? true,
      },
    });
    return reply.code(201).send({
      site: {
        id: site.id,
        name: site.name,
        baseUrl: site.baseUrl,
        rankMathActive: site.rankMathActive,
      },
    });
  });

  app.patch("/:id/credentials", async (req, reply) => {
    const { id } = req.params as { id: string };
    const existing = await prisma.site.findUnique({ where: { id } });
    if (!existing) return reply.code(404).send({ error: "Site not found" });
    const body = z
      .object({
        wpUsername: z.string().min(1),
        wpAppPassword: z.string().min(1),
      })
      .parse(req.body);
    await prisma.site.update({
      where: { id },
      data: {
        wpUsername: body.wpUsername,
        wpAppPassword: encryptSecret(body.wpAppPassword),
      },
    });
    return { ok: true };
  });

  app.delete("/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const existing = await prisma.site.findUnique({ where: { id } });
    if (!existing) return reply.code(404).send({ error: "Site not found" });
    await prisma.site.delete({ where: { id } });
    return { ok: true };
  });

  app.get("/:id/categories", async (req, reply) => {
    const { id } = req.params as { id: string };
    const site = await prisma.site.findUnique({ where: { id } });
    if (!site) return reply.code(404).send({ error: "Site not found" });
    // ?refresh=1 pulls the latest categories from WordPress first (renames, removals).
    // If WP is unreachable we fall back to the cached list instead of failing.
    if ((req.query as { refresh?: string }).refresh) {
      try {
        await syncCategories(site);
      } catch (err) {
        req.log.warn({ err }, "category refresh from WordPress failed; using cached list");
      }
    }
    const categories = await prisma.category.findMany({
      where: { siteId: id },
      orderBy: { name: "asc" },
      select: { id: true, name: true, slug: true, parentId: true, wpCategoryId: true },
    });
    return { categories };
  });

  app.get("/:id/facts", async (req, reply) => {
    const { id } = req.params as { id: string };
    const site = await prisma.site.findUnique({ where: { id } });
    if (!site) return reply.code(404).send({ error: "Site not found" });
    const facts = await prisma.businessFact.findMany({
      where: { siteId: id },
      orderBy: { key: "asc" },
    });
    return { facts };
  });

  app.put("/:id/facts", async (req, reply) => {
    const { id } = req.params as { id: string };
    const site = await prisma.site.findUnique({ where: { id } });
    if (!site) return reply.code(404).send({ error: "Site not found" });
    const body = z
      .object({
        facts: z.array(
          z.object({
            key: z.string().min(1),
            value: z.string().min(1),
          })
        ),
      })
      .parse(req.body ?? {});

    await prisma.$transaction(async (tx) => {
      await tx.businessFact.deleteMany({ where: { siteId: id } });
      if (body.facts.length > 0) {
        await tx.businessFact.createMany({
          data: body.facts.map((f) => ({
            siteId: id,
            key: f.key.trim(),
            value: f.value.trim(),
          })),
        });
      }
    });

    const facts = await prisma.businessFact.findMany({
      where: { siteId: id },
      orderBy: { key: "asc" },
    });
    return { facts };
  });
};
