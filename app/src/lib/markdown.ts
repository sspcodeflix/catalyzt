/**
 * A small Markdown reader for App Context passages (R20): headings, paragraphs, lists, fenced code,
 * block quotes and GitHub tables, with **bold**, *italic*, `code` and [links](url) inline. It
 * returns plain data that the page turns into React elements; nothing is ever injected as HTML, so
 * raw HTML in a passage shows as text.
 */

export type Align = 'left' | 'center' | 'right' | null;

export type MdBlock =
  | { kind: 'h'; level: number; text: string }
  | { kind: 'p'; text: string }
  | { kind: 'ul' | 'ol'; items: string[] }
  | { kind: 'code'; text: string }
  | { kind: 'quote'; text: string }
  | { kind: 'table'; header: string[]; align: Align[]; rows: string[][] };

export type MdInline = { kind: 'text'; text: string } | { kind: 'b' | 'i' | 'code'; text: string } | { kind: 'link'; text: string; href: string };

const SEP_CELL = /^\s*:?-{3,}:?\s*$/;

/** Cells of one table line: outer pipes dropped, `\|` kept as a literal pipe. */
export function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, '|').trim());
}

/** The line under a table header: `---|:---:|---:`, with or without outer pipes. */
const isSeparator = (line: string) => line.includes('|') && line.includes('-') && splitRow(line).every((c) => SEP_CELL.test(c));

const alignOf = (cell: string): Align => {
  const c = cell.trim();
  if (c.startsWith(':') && c.endsWith(':')) return 'center';
  if (c.endsWith(':')) return 'right';
  if (c.startsWith(':')) return 'left';
  return null;
};

/** Block structure of a passage. Lines inside a paragraph are joined with spaces. */
export function parseMarkdown(text: string): MdBlock[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const out: MdBlock[] = [];
  let para: string[] = [];
  const endPara = () => {
    if (para.length) out.push({ kind: 'p', text: para.join(' ') });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();
    if (!line) {
      endPara();
      continue;
    }
    const fence = /^(```|~~~)/.exec(line);
    if (fence) {
      endPara();
      const body: string[] = [];
      for (i++; i < lines.length && !lines[i].trim().startsWith(fence[1]); i++) body.push(lines[i]);
      out.push({ kind: 'code', text: body.join('\n') });
      continue;
    }
    // A table: a line with a pipe followed by a separator line with as many cells or fewer.
    if (line.includes('|') && i + 1 < lines.length && isSeparator(lines[i + 1])) {
      endPara();
      const header = splitRow(line);
      const align = splitRow(lines[i + 1]).map(alignOf);
      const rows: string[][] = [];
      for (i += 2; i < lines.length && lines[i].trim() && lines[i].includes('|'); i++) {
        const cells = splitRow(lines[i]);
        rows.push(header.map((_, k) => cells[k] ?? ''));
      }
      i--;
      out.push({ kind: 'table', header, align: header.map((_, k) => align[k] ?? null), rows });
      continue;
    }
    const h = /^(#{1,6})\s+(.*?)\s*#*$/.exec(line);
    if (h) {
      endPara();
      out.push({ kind: 'h', level: h[1].length, text: h[2] });
      continue;
    }
    const ul = /^[-*+•]\s+(.*)$/.exec(line);
    const ol = /^\d+[.)]\s+(.*)$/.exec(line);
    if (ul || ol) {
      endPara();
      const kind = ul ? 'ul' : 'ol';
      const item = (ul ?? ol)![1];
      const last = out[out.length - 1];
      if (last && last.kind === kind) last.items.push(item);
      else out.push({ kind, items: [item] });
      continue;
    }
    if (line.startsWith('>')) {
      endPara();
      const last = out[out.length - 1];
      const t = line.replace(/^>\s?/, '');
      if (last && last.kind === 'quote') last.text += ` ${t}`;
      else out.push({ kind: 'quote', text: t });
      continue;
    }
    // A continuation line of a list item (indented, after an item) stays with the item.
    const last = out[out.length - 1];
    if (!para.length && /^\s+/.test(raw) && last && (last.kind === 'ul' || last.kind === 'ol')) {
      last.items[last.items.length - 1] += ` ${line}`;
      continue;
    }
    para.push(line);
  }
  endPara();
  return out;
}

/** Only web and in-app links are kept; anything else (javascript:, data:) is shown as text. */
export const safeHref = (href: string): string | null => (/^(https?:\/\/|\/|#|mailto:)/i.test(href.trim()) ? href.trim() : null);

/** Inline marks of one line of text. */
export function parseInline(text: string): MdInline[] {
  const out: MdInline[] = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*|__[^_]+__)|(!?\[[^\]]*\]\([^)\s]+(?:\s+"[^"]*")?\))|(\*[^*\s][^*]*\*)/g;
  let at = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > at) out.push({ kind: 'text', text: text.slice(at, m.index) });
    const t = m[0];
    if (m[1]) out.push({ kind: 'code', text: t.slice(1, -1) });
    else if (m[2]) out.push({ kind: 'b', text: t.slice(2, -2) });
    else if (m[3]) {
      const l = /^!?\[([^\]]*)\]\(([^)\s]+)/.exec(t)!;
      const href = safeHref(l[2]);
      const label = l[1] || l[2];
      out.push(href ? { kind: 'link', text: label, href } : { kind: 'text', text: label });
    } else out.push({ kind: 'i', text: t.slice(1, -1) });
    at = m.index + t.length;
  }
  if (at < text.length) out.push({ kind: 'text', text: text.slice(at) });
  return out;
}

/**
 * Passages indexed before line breaks were kept are one long line, so a table's rows cannot be told
 * apart. For those, the separator row is dropped and cell pipes become a middle dot, so the text at
 * least reads cleanly.
 */
export function cleanFlatTable(text: string): string {
  if (text.includes('\n') || !/\|\s*:?-{3,}:?\s*\|/.test(text)) return text;
  return text
    .replace(/\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?/g, ' | ')
    .replace(/\s*\|(\s*\|)*\s*/g, ' · ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** Build and CI files are shown as they are, not read as Markdown. */
export const isPlainFile = (locator: string) => {
  const path = locator.replace(/\s+¶\d+$/, '');
  const name = path.split('/').pop() ?? path;
  return /\.(ya?ml|xml|json|gradle|kts|toml|ini|cfg|properties|sh)$/i.test(name) || /^(Dockerfile([.-].*)?|Makefile|makefile|GNUmakefile|Jenkinsfile)$/.test(name);
};
