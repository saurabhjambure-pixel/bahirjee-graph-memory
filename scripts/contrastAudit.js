/**
 * WCAG AA contrast auditor — paste-able into the browser console, or run via
 * a browser devtools console.
 *
 * Walks every visible text node, resolves the *effective* background by
 * compositing translucent ancestors (the glass surfaces make this necessary —
 * a naive getComputedStyle read returns rgba(255,255,255,0.72) and lies), then
 * reports anything under the AA threshold for its size.
 *
 * Returns { total, failures: [...] }.
 */
window.__contrastAudit = function () {
  const parse = (c) => {
    const m = String(c).match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(',').map((x) => parseFloat(x.trim()));
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  // Proper source-over compositing. This previously hardcoded `a: 1` on the result,
  // which meant stacking two 16%-alpha layers of the same hue produced the FULL
  // saturated colour instead of ~29% — reporting false contrast failures wherever
  // translucent surfaces nest (e.g. an accent chip inside an accent-tinted row).
  const composite = (fg, bg) => {
    const a = fg.a + bg.a * (1 - fg.a);
    if (a === 0) return { r: 0, g: 0, b: 0, a: 0 };
    return {
      r: (fg.r * fg.a + bg.r * bg.a * (1 - fg.a)) / a,
      g: (fg.g * fg.a + bg.g * bg.a * (1 - fg.a)) / a,
      b: (fg.b * fg.a + bg.b * bg.a * (1 - fg.a)) / a,
      a,
    };
  };
  const lum = ({ r, g, b }) => {
    const f = (v) => {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const ratio = (a, b) => {
    const [l1, l2] = [lum(a), lum(b)].sort((x, y) => y - x);
    return (l1 + 0.05) / (l2 + 0.05);
  };

  // Walk up compositing every translucent background until fully opaque.
  const effectiveBg = (el) => {
    let acc = null;
    let node = el;
    while (node && node !== document.documentElement.parentNode) {
      const bg = parse(getComputedStyle(node).backgroundColor);
      if (bg && bg.a > 0) acc = acc ? composite(acc, bg) : bg;
      if (acc && acc.a >= 0.999) return acc;
      node = node.parentElement;
    }
    // Nothing opaque found — fall back to the page base. The aurora lives on <html>
    // and <body> is transparent, so read html first; body would report rgba(0,0,0,0)
    // and silently score every element against black.
    const rootBg =
      parse(getComputedStyle(document.documentElement).backgroundColor) ||
      parse(getComputedStyle(document.body).backgroundColor);
    const base = rootBg && rootBg.a > 0 ? rootBg : { r: 255, g: 255, b: 255, a: 1 };
    return acc ? composite(acc, base) : base;
  };

  const failures = [];
  let total = 0;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const seen = new Set();

  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const text = n.textContent.trim();
    if (!text) continue;
    // Emoji render as colour glyphs and ignore the CSS `color` property, so measuring
    // `color` against the background says nothing about their legibility.
    if (/^[\p{Extended_Pictographic}️‍\s]+$/u.test(text)) continue;
    const el = n.parentElement;
    if (!el || seen.has(el)) continue;
    seen.add(el);

    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') continue;
    const rect = el.getBoundingClientRect();
    if (!rect.width || !rect.height) continue;
    const opacity = parseFloat(cs.opacity);
    if (opacity < 0.15) continue; // decorative / deliberately faded

    const fgRaw = parse(cs.color);
    if (!fgRaw) continue;
    const bg = effectiveBg(el);
    const fg = fgRaw.a < 1 ? composite(fgRaw, bg) : fgRaw;

    const px = parseFloat(cs.fontSize);
    const weight = parseInt(cs.fontWeight, 10) || 400;
    // WCAG "large text": >=24px, or >=18.66px when bold.
    const isLarge = px >= 24 || (px >= 18.66 && weight >= 700);
    const required = isLarge ? 3.0 : 4.5;
    const r = ratio(fg, bg);

    total++;
    if (r < required) {
      failures.push({
        text: text.slice(0, 48),
        ratio: +r.toFixed(2),
        required,
        px: +px.toFixed(1),
        weight,
        color: cs.color,
        bg: `rgb(${Math.round(bg.r)}, ${Math.round(bg.g)}, ${Math.round(bg.b)})`,
        cls: (el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className || '')
          .toString().slice(0, 90),
      });
    }
  }
  failures.sort((a, b) => a.ratio - b.ratio);
  return { total, failCount: failures.length, failures };
};
