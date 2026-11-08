import type { ReactNode } from 'react';

import { cleanFlatTable, isPlainFile, parseInline, parseMarkdown } from '../lib/markdown';

/**
 * A passage's text, readable (R20): Markdown documents rendered (headings, lists, tables, code),
 * build and CI files kept as written in a monospace block. React elements only; the text is never
 * injected as HTML.
 */
export function PassageText({ text, locator }: { text: string; locator: string }) {
  if (isPlainFile(locator)) return (
      <pre className="passage-pre" tabIndex={0} aria-label={`File: ${locator}`}>
        {text}
      </pre>
    );
  const blocks = parseMarkdown(cleanFlatTable(text));
  return (
    <div className="passage-md">
      {blocks.map((b, i) => {
        switch (b.kind) {
          case 'h':
            return (
              <p key={i} className="passage-h">
                <strong>{inline(b.text)}</strong>
              </p>
            );
          case 'p':
            return <p key={i}>{inline(b.text)}</p>;
          case 'quote':
            return <blockquote key={i}>{inline(b.text)}</blockquote>;
          case 'code':
            return (
              <pre key={i} className="passage-pre" tabIndex={0} aria-label="Code">
                {b.text}
              </pre>
            );
          case 'ul':
          case 'ol': {
            const List = b.kind;
            return (
              <List key={i}>
                {b.items.map((it, j) => (
                  <li key={j}>{inline(it)}</li>
                ))}
              </List>
            );
          }
          case 'table':
            return (
              // A wide table scrolls sideways; keyboard users need to reach it to scroll it.
              <div key={i} className="passage-table" tabIndex={0} role="region" aria-label={`Table: ${b.header.filter(Boolean).slice(0, 3).join(', ') || 'passage table'}`}>
                <table>
                  <thead>
                    <tr>
                      {b.header.map((h, k) => (
                        <th key={k} scope="col" style={b.align[k] ? { textAlign: b.align[k]! } : undefined}>
                          {inline(h)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {b.rows.map((r, j) => (
                      <tr key={j}>
                        {r.map((c, k) => (
                          <td key={k} style={b.align[k] ? { textAlign: b.align[k]! } : undefined}>
                            {inline(c)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
        }
      })}
    </div>
  );
}

function inline(text: string): ReactNode[] {
  return parseInline(text).map((t, i) => {
    switch (t.kind) {
      case 'b':
        return <strong key={i}>{t.text}</strong>;
      case 'i':
        return <em key={i}>{t.text}</em>;
      case 'code':
        return (
          <code key={i} className="mono">
            {t.text}
          </code>
        );
      case 'link':
        return (
          <a key={i} href={t.href} target={t.href.startsWith('http') ? '_blank' : undefined} rel="noopener noreferrer">
            {t.text}
          </a>
        );
      default:
        return t.text;
    }
  });
}
