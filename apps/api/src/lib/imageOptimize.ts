import sharp from "sharp";

const WIDTH = 1200;
const HEIGHT = 630; // 1.91:1 (Open Graph / featured image standard)
const MAX_BYTES = 100 * 1024; // ~100 KB target

/**
 * Convert a generated image to a web-ready JPEG:
 * exactly 1200x630 (center/attention crop), progressive, quality lowered
 * step by step until the file is <= ~100 KB.
 * Falls back to the original bytes if conversion fails.
 */
export async function optimizeForWeb(bytes: Buffer, mime = "image/png") {
  try {
    const base = sharp(bytes)
      .rotate()
      .resize({ width: WIDTH, height: HEIGHT, fit: "cover", position: "attention" })
      .flatten({ background: "#ffffff" });

    let out = Buffer.alloc(0);
    for (let q = 82; q >= 40; q -= 6) {
      out = await base
        .clone()
        .jpeg({ quality: q, progressive: true, mozjpeg: true })
        .toBuffer();
      if (out.length <= MAX_BYTES) break;
    }
    return { bytes: out, mime: "image/jpeg", ext: "jpg" };
  } catch (err) {
    console.warn("[imageOptimize] failed, uploading original:", err);
    const ext = mime.includes("jpeg") ? "jpg" : mime.includes("webp") ? "webp" : "png";
    return { bytes, mime, ext };
  }
}
