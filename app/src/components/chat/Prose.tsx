import type { ReactNode } from 'react';

import type { Citation } from '../../lib/types';

interface ProseProps {
  text: string;
  citations: Citation[];
  /** Shows a blinking cursor at the end while the answer streams in. */
  streaming?: boolean;
}

/**
 * Renders answer text: paragraphs, "- " and "1. " lists, **bold**, `code` and [n] citations.
 * It builds React elements only; model output is never injected as HTML.
 */
export function Prose({ text, citations, streaming }: ProseProps) {
  const blocks = toBlocks(text);
  const cursor = streaming ? <span className="cursor" aria-hidden="true" /> : null;
  if (blocks.length === 0) {
    return <p className="prose">{cursor ?? null}</p>;
  }
  return (
    <div className="prose" aria-busy={streaming || undefined}>
      {blocks.map((b, i) => {
        const last = i === blocks.length - 1;
        if (b.kind === 'p') {
          return (
            <p key={i}>
              {inline(b.lines.join(' '), citations)}
              {last && cursor}
            </p>
          );
        }
        const List = b.kind === 'ol' ? 'ol' : 'ul';
        return (
          <List key={i}>
            {b.items.map((it, j) => (
              <li key={j}>
                {inline(it, citations)}
                {last && j === b.items.length - 1 && cursor}
              </li>
            ))}
          </List>
        );
      })}
    </div>
  );
}

type TextBlock = { kind: 'p'; lines: string[] } | { kind: 'ul' | 'ol'; items: string[] };

function toBlocks(text: string): TextBlock[] {
  const out: TextBlock[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const last = out[out.length - 1];
    if (!line) {
      out.push({ kind: 'p', lines: [] });
      continue;
    }
    const ul = /^[-*•]\s+(.*)$/.exec(line);
    const ol = /^\d+[.)]\s+(.*)$/.exec(line);
    // Headings are shown as bold lines; the system prompt asks for none, but models drift.
    const h = /^#{1,6}\s+(.*)$/.exec(line);
    if (ul || ol) {
      const kind = ul ? 'ul' : 'ol';
      const item = (ul ?? ol)![1];
      if (last?.kind === kind) last.items.push(item);
      else out.push({ kind, items: [item] });
    } else if (last?.kind === 'p' && last.lines.length > 0 && !h) {
      last.lines.push(line);
    } else if (h) {
      // A heading stands alone: close it so the next line starts a new paragraph.
      out.push({ kind: 'p', lines: [`**${h[1]}**`] }, { kind: 'p', lines: [] });
    } else {
      out.push({ kind: 'p', lines: [line] });
    }
  }
  return out.filter((b) => b.kind !== 'p' || b.lines.length > 0);
}

function inline(text: string, citations: Citation[]): ReactNode[] {
  return text.split(/(`[^`]+`|\*\*[^*]+\*\*|\[\d+\])/g).map((part, i) => {
    if (part.length > 1 && part.startsWith('`') && part.endsWith('`')) {
      return (
        <code key={i} className="mono">
          {part.slice(1, -1)}
        </code>
      );
    }
    if (part.length > 4 && part.startsWith('**') && part.endsWith('**')) return <strong key={i}>{part.slice(2, -2)}</strong>;
    const cite = /^\[(\d+)\]$/.exec(part);
    if (cite) {
      const c = citations.find((x) => x.n === Number(cite[1]));
      // Only known sources become citation chips; a model-invented [n] stays plain text.
      if (!c) return part;
      return (
        <span key={i} className="cite" tabIndex={0} title={`${c.title} · ${c.detail}`} aria-label={`Source ${c.n}: ${c.title}, ${c.detail}`}>
          {cite[1]}
        </span>
      );
    }
    return part;
  });
}
