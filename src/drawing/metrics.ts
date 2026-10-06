// Text metrics for IBM Plex Sans, so layout can run without a DOM (browser and Node alike).
// Advance widths in font units (1000/em), extracted from src/assets/fonts/IBMPlexSans-*.woff.

const CHARS =
  " !\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~" +
  "Ωεδθφ−∞°×±·≈→μλ√²³₀–—…’“”κ≤≥✓Γ•";

const W400 = [
  236, 284, 419, 713, 598, 927, 694, 242, 335, 335, 450, 600, 272, 399, 272, 383, 600, 600, 600, 600, 600, 600, 600, 600,
  600, 600, 292, 292, 600, 600, 600, 477, 891, 641, 653, 621, 671, 583, 559, 695, 707, 400, 510, 634, 501, 812, 707, 708,
  606, 708, 640, 581, 572, 678, 609, 891, 613, 593, 580, 317, 383, 317, 600, 565, 600, 534, 580, 503, 580, 549, 324, 528,
  568, 250, 250, 527, 272, 873, 568, 560, 580, 580, 367, 487, 351, 568, 492, 768, 507, 499, 464, 343, 314, 343, 600, 716,
  518, 560, 562, 715, 600, 740, 468, 600, 600, 326, 600, 820, 578, 509, 600, 346, 346, 378, 588, 780, 803, 273, 475, 474,
  527, 600, 600, 912, 499, 396,
];
const W600 = [
  236, 309, 471, 656, 600, 960, 713, 260, 337, 337, 556, 600, 298, 402, 298, 437, 600, 600, 600, 600, 600, 600, 600, 600,
  600, 600, 318, 318, 600, 600, 600, 493, 899, 672, 663, 642, 689, 600, 577, 712, 719, 423, 545, 678, 521, 816, 719, 712,
  641, 712, 664, 611, 580, 690, 638, 949, 655, 632, 599, 329, 437, 329, 600, 559, 600, 559, 600, 513, 600, 558, 350, 545,
  588, 276, 276, 562, 294, 888, 588, 563, 600, 600, 393, 499, 374, 588, 524, 819, 544, 524, 502, 363, 376, 363, 600, 721,
  525, 563, 572, 756, 600, 776, 470, 600, 600, 350, 600, 876, 605, 529, 600, 347, 345, 372, 588, 780, 868, 292, 517, 517,
  564, 600, 600, 912, 510, 420,
];

const TABLE: Record<string, [number, number]> = {};
for (let i = 0; i < CHARS.length; i++) TABLE[CHARS[i]] = [W400[i], W600[i]];

/** Width of `text` in the same unit as `size` (the font size, i.e. the em). */
export function textWidth(text: string, size: number, weight: 400 | 600 = 400): number {
  let w = 0;
  for (const ch of text) {
    const e = TABLE[ch];
    w += e ? e[weight === 600 ? 1 : 0] : 600;
  }
  return (w / 1000) * size;
}

/** Cap height of IBM Plex Sans relative to the em (used to centre text vertically). */
export const CAP_HEIGHT = 0.698;

/** Greedy word wrap to a maximum width. */
export function wrap(text: string, size: number, maxWidth: number, weight: 400 | 600 = 400): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (cur && textWidth(next, size, weight) > maxWidth) {
      lines.push(cur);
      cur = w;
    } else cur = next;
  }
  if (cur) lines.push(cur);
  return lines;
}

/** Shorten `text` with an ellipsis so it fits `maxWidth`. */
export function fit(text: string, size: number, maxWidth: number, weight: 400 | 600 = 400): string {
  if (textWidth(text, size, weight) <= maxWidth) return text;
  let s = text;
  while (s.length > 1 && textWidth(s + "…", size, weight) > maxWidth) s = s.slice(0, -1);
  return s + "…";
}
