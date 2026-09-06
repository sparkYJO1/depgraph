// Renders a Markdown table with right-aligned numeric columns, because the
// benchmark output is pasted into the README verbatim and has to read well
// there as well as in a terminal.

export function markdownTable(headers, rows, { alignRight = [] } = {}) {
  const widths = headers.map((header, column) =>
    Math.max(header.length, ...rows.map((row) => String(row[column]).length)),
  );

  const pad = (value, column) =>
    alignRight.includes(column)
      ? String(value).padStart(widths[column])
      : String(value).padEnd(widths[column]);

  const line = (cells) => `| ${cells.map(pad).join(" | ")} |`;
  const rule = `|${widths.map((width, column) => (alignRight.includes(column) ? `${"-".repeat(width + 1)}:` : `${"-".repeat(width + 2)}`)).join("|")}|`;

  return [line(headers), rule, ...rows.map(line)].join("\n");
}

export function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
