const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s));

export const bold = paint(1);
export const dim = paint(2);
export const red = paint(31);
export const green = paint(32);
export const yellow = paint(33);
export const cyan = paint(36);

const visibleLength = (s) => String(s).replace(/\x1b\[\d+m/g, '').length;

export function table(headers, rows) {
  const widths = headers.map((h, i) =>
    Math.max(visibleLength(h), ...rows.map((r) => visibleLength(r[i]))),
  );
  const line = (cells) =>
    cells
      .map((c, i) => String(c) + ' '.repeat(widths[i] - visibleLength(c)))
      .join('  ')
      .trimEnd();
  return [bold(line(headers)), ...rows.map(line)].join('\n');
}

export const mbps = (bitsPerSecond) => `${Math.round(bitsPerSecond / 1e6)} Mbps`;
