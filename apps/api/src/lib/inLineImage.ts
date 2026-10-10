/** Insert a figure into the main content area: before the 2nd <h2>, else after the 2nd paragraph, else at the end. */
export function inlineFigure(src: string, alt: string) {
  const esc = alt.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  return `<figure class="wp-block-image size-large"><img src="${src}" alt="${esc}" loading="lazy" /></figure>`;
}

export function insertInlineImage(html: string, src: string, alt: string) {
  const fig = inlineFigure(src, alt);

  const h2 = [...html.matchAll(/<h2\b/gi)];
  if (h2.length >= 2 && h2[1].index !== undefined) {
    const i = h2[1].index;
    return `${html.slice(0, i)}${fig}\n${html.slice(i)}`;
  }
  const closes = [...html.matchAll(/<\/p>/gi)];
  if (closes.length >= 2 && closes[1].index !== undefined) {
    const i = closes[1].index + 4;
    return `${html.slice(0, i)}\n${fig}${html.slice(i)}`;
  }
  return `${html}\n${fig}`;
}
