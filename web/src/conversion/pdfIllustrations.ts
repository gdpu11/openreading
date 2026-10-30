export type PageBox = { x: number; y: number; width: number; height: number };
export type OcrLine = {
  text: string;
  confidence: number;
  alternatives: string[];
  box: PageBox;
  uncertain?: boolean;
  retried?: boolean;
};
export type DetailedOCR = {
  engine: string;
  lines: OcrLine[];
  secondaryText: string;
};
export type FigureRegion = {
  left: number;
  top: number;
  width: number;
  height: number;
};

// Remove recognized text from a small analysis bitmap, then locate substantial
// connected graphics. Crops are later taken from the original high-resolution
// canvas, so chart labels and fine strokes are preserved in the actual image.
export function detectIllustrations(
  image: { width: number; height: number; data: Uint8ClampedArray },
  lines: OcrLine[],
): FigureRegion[] {
  const { width: w, height: h, data } = image;
  const ink = new Uint8Array(w * h),
    margin = Math.max(2, Math.round(w * 0.02));
  for (let y = margin; y < h - margin; y++)
    for (let x = margin; x < w - margin; x++) {
      const i = (y * w + x) * 4,
        r = data[i],
        g = data[i + 1],
        b = data[i + 2];
      if (
        data[i + 3] > 100 &&
        (r * 0.299 + g * 0.587 + b * 0.114 < 210 ||
          Math.max(r, g, b) - Math.min(r, g, b) > 35)
      )
        ink[y * w + x] = 1;
    }
  for (const { box } of lines) {
    if (
      ![box.x, box.y, box.width, box.height].every(Number.isFinite) ||
      box.width <= 0 ||
      box.height <= 0
    )
      continue;
    const left = Math.min(w, Math.max(0, Math.floor(box.x * w) - 2)),
      right = Math.max(0, Math.min(w, Math.ceil((box.x + box.width) * w) + 2));
    const top = Math.min(
        h,
        Math.max(0, Math.floor((1 - box.y - box.height) * h) - 2),
      ),
      bottom = Math.max(0, Math.min(h, Math.ceil((1 - box.y) * h) + 2));
    if (right <= left || bottom <= top) continue;
    for (let y = top; y < bottom; y++) ink.fill(0, y * w + left, y * w + right);
  }
  const regions: {
    left: number;
    top: number;
    right: number;
    bottom: number;
    pixels: number;
  }[] = [];
  const isGraphic = (r: (typeof regions)[number]) => {
    const area = (r.right - r.left + 1) * (r.bottom - r.top + 1);
    if (area <= w * h * 0.6) return true;
    // A full-page photograph can be a genuine illustration. A thin scan
    // border cannot; nor should a dense page of recognized body text be kept.
    if (r.pixels / area < 0.35) return false;
    const textArea = lines.reduce((total, { box }) => {
      const iw = Math.max(
        0,
        Math.min(r.right + 1, (box.x + box.width) * w) -
          Math.max(r.left, box.x * w),
      );
      const ih = Math.max(
        0,
        Math.min(r.bottom + 1, (1 - box.y) * h) -
          Math.max(r.top, (1 - box.y - box.height) * h),
      );
      return total + iw * ih;
    }, 0);
    return textArea < area * 0.25;
  };
  const queue = new Int32Array(w * h);
  for (let start = 0; start < ink.length; start++) {
    if (!ink[start]) continue;
    let head = 0,
      tail = 1,
      left = start % w,
      right = left,
      top = Math.floor(start / w),
      bottom = top;
    queue[0] = start;
    ink[start] = 0;
    while (head < tail) {
      const at = queue[head++],
        x = at % w,
        y = Math.floor(at / w);
      left = Math.min(left, x);
      right = Math.max(right, x);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx,
            ny = y + dy;
          if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
          const next = ny * w + nx;
          if (ink[next]) {
            ink[next] = 0;
            queue[tail++] = next;
          }
        }
    }
    const rw = right - left + 1,
      rh = bottom - top + 1,
      area = rw * rh;
    if (
      rw < w * 0.08 ||
      rh < h * 0.028 ||
      area < w * h * 0.003 ||
      tail / area < 0.012 ||
      rw / rh > 12 ||
      rh / rw > 12
    )
      continue;
    const region = { left, top, right, bottom, pixels: tail };
    if (isGraphic(region)) regions.push(region);
  }
  // Nearby disconnected strokes often belong to one chart. Do not merge
  // through a full-width body-text line between the graphics.
  const textBarrier = (
    a: (typeof regions)[number],
    b: (typeof regions)[number],
  ) =>
    lines.some(({ box }) => {
      const y = (1 - box.y - box.height / 2) * h;
      return (
        box.width > 0.4 &&
        y > Math.min(a.bottom, b.bottom) &&
        y < Math.max(a.top, b.top)
      );
    });
  for (let i = 0; i < regions.length; i++)
    for (let j = i + 1; j < regions.length;) {
      const a = regions[i],
        b = regions[j],
        gap = Math.max(4, w * 0.012);
      if (
        a.left <= b.right + gap &&
        b.left <= a.right + gap &&
        a.top <= b.bottom + gap &&
        b.top <= a.bottom + gap &&
        !textBarrier(a, b)
      ) {
        a.left = Math.min(a.left, b.left);
        a.right = Math.max(a.right, b.right);
        a.top = Math.min(a.top, b.top);
        a.bottom = Math.max(a.bottom, b.bottom);
        a.pixels += b.pixels;
        regions.splice(j, 1);
        j = i + 1;
      } else j++;
    }
  return regions
    .filter(isGraphic)
    .map((r) => {
      const left = Math.max(0, r.left - 4),
        top = Math.max(0, r.top - 4),
        right = Math.min(w, r.right + 5),
        bottom = Math.min(h, r.bottom + 5);
      return {
        left: left / w,
        top: top / h,
        width: (right - left) / w,
        height: (bottom - top) / h,
      };
    })
    .sort((a, b) => a.top - b.top || a.left - b.left);
}

export function lineInsideFigure(line: OcrLine, figure: FigureRegion) {
  const { box } = line,
    top = 1 - box.y - box.height;
  const iw = Math.max(
    0,
    Math.min(box.x + box.width, figure.left + figure.width) -
      Math.max(box.x, figure.left),
  );
  const ih = Math.max(
    0,
    Math.min(top + box.height, figure.top + figure.height) -
      Math.max(top, figure.top),
  );
  return iw * ih > box.width * box.height * 0.6;
}
