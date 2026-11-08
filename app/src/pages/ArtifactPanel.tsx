import * as Tabs from '@radix-ui/react-tabs';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';

import { Icon } from '../components/Icon';
import { useChat } from '../lib/chatStore';
import { api, hexaChanged } from '../lib/hexa';
import type { Citation, CodeArtifact, CriterionStatus, TestSuggestion, UatArtifact } from '../lib/types';

/** Side panel for a work product. Rendered by the nested route /chat/:chatId/artifact/:artifactId. */
export function ArtifactPanel() {
  const { chatId, artifactId } = useParams();
  const chat = useChat(chatId);
  const artifact = artifactId ? chat?.artifacts[artifactId] : undefined;
  const [copied, setCopied] = useState(false);
  const ref = useRef<HTMLElement>(null);

  // Below 900px the panel stacks under the chat, so bring it into view when it opens.
  useEffect(() => {
    if (window.matchMedia('(max-width: 899px)').matches) ref.current?.scrollIntoView({ block: 'start' });
  }, [artifactId]);

  const close = (
    <Link to={`/chat/${chatId}`} className="icon" aria-label="Close panel">
      <Icon name="close" />
    </Link>
  );

  if (!artifact) {
    return (
      <section ref={ref} className="panel" aria-label="Not found">
        <div className="phead">
          <div className="t">
            <b>Not found</b>
            <span>This item doesn't exist or you don't have access.</span>
          </div>
          {close}
        </div>
      </section>
    );
  }

  const sources = chat!.messages.flatMap((m) => (m.role === 'assistant' ? m.citations : []));

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(artifact.kind === 'code' ? artifact.lines.map((l) => l.text).join('\n') : uatAsText(artifact));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked */
    }
  };

  return (
    <section ref={ref} className="panel" aria-label={artifact.title}>
      <div className="phead">
        <div className="t">
          <b>{artifact.title}</b>
          <span>{artifact.subtitle}</span>
        </div>
        {artifact.kind === 'uat' && (
          <Link to={`/tickets/${artifact.ticketKey}`} className="ghost hidem">
            <Icon name="doc" small />
            Ticket
          </Link>
        )}
        <button type="button" className="ghost" onClick={copy}>
          <Icon name={copied ? 'check' : 'copy'} small />
          {copied ? 'Copied' : 'Copy'}
        </button>
        {close}
      </div>
      {artifact.kind === 'code' ? <CodeView a={artifact} sources={sources} /> : <UatView a={artifact} sources={sources} />}
    </section>
  );
}

function PanelTabs({ tabs }: { tabs: { value: string; label: string; content: ReactNode }[] }) {
  return (
    <Tabs.Root defaultValue={tabs[0].value} className="pbody" style={{ gap: 18 }}>
      <Tabs.List className="tabs" aria-label="Views">
        {tabs.map((t) => (
          <Tabs.Trigger key={t.value} value={t.value}>
            {t.label}
          </Tabs.Trigger>
        ))}
      </Tabs.List>
      {tabs.map((t) => (
        <Tabs.Content key={t.value} value={t.value} className="tabpane">
          {t.content}
        </Tabs.Content>
      ))}
    </Tabs.Root>
  );
}

function SourcesList({ sources }: { sources: Citation[] }) {
  return (
    <ol className="sources">
      {sources.map((s, i) => (
        <li key={i}>
          <span className="cite">{s.n}</span>
          <div>
            <b>{s.title}</b>
            <span className="muted">{s.detail}</span>
          </div>
        </li>
      ))}
    </ol>
  );
}

function CodeView({ a, sources }: { a: CodeArtifact; sources: Citation[] }) {
  return (
    <PanelTabs
      tabs={[
        {
          value: 'code',
          label: 'Code',
          content: (
            <>
              <div className="code">
                <div className="file">
                  <span>{a.path}</span>
                  <span className="pill pass">{a.changeLabel}</span>
                </div>
                <pre>
                  {a.lines.map((l) => (
                    <span key={l.n} className={l.change}>
                      <span className="ln">{l.n}</span>
                      {l.text}
                      {'\n'}
                    </span>
                  ))}
                </pre>
              </div>
              <div className="callout">
                <Icon name="doc" small />
                <span>{a.note}</span>
              </div>
            </>
          ),
        },
        {
          value: 'cases',
          label: `Test cases ${a.testCases.length}`,
          content: (
            <div className="tablewrap">
              <table>
                <thead>
                  <tr>
                    <th>Test case</th>
                    <th>Title</th>
                    <th>Requirement</th>
                  </tr>
                </thead>
                <tbody>
                  {a.testCases.map((t) => (
                    <tr key={t.id}>
                      <td className="mono">{t.id}</td>
                      <td>{t.title}</td>
                      <td className="mono">{t.requirement}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ),
        },
        { value: 'sources', label: `Sources ${sources.length}`, content: <SourcesList sources={sources} /> },
      ]}
    />
  );
}

/** Status colours follow DESIGN.md: green passing, blue waiting, neutral grey for no test. Always with text. */
export const criterionPill: Record<CriterionStatus, { cls: string; label: string }> = {
  passing: { cls: 'pass', label: 'Covered' },
  failing: { cls: 'crit', label: 'Failing' },
  'not-run': { cls: 'info', label: 'Not run yet' },
  'no-test': { cls: '', label: 'No test' },
};

function UatView({ a, sources }: { a: UatArtifact; sources: Citation[] }) {
  const count = (s: CriterionStatus) => a.criteria.filter((c) => c.status === s).length;
  return (
    <PanelTabs
      tabs={[
        {
          value: 'criteria',
          label: 'Acceptance criteria',
          content: (
            <>
              <div className="uatsum" aria-label="Summary">
                {(['passing', 'failing', 'not-run', 'no-test'] as const).map((s) => (
                  <div key={s} className="kpi">
                    <b>{count(s)}</b>
                    <span>{criterionPill[s].label}</span>
                  </div>
                ))}
              </div>
              <div className="tablewrap">
                <table>
                  <thead>
                    <tr>
                      <th>ID</th>
                      <th>Criterion</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {a.criteria.map((c) => (
                      <tr key={c.id}>
                        <td className="mono">{c.id}</td>
                        <td>
                          {c.text}
                          <small className="evidence">{c.evidence}</small>
                          {c.suggestions?.length ? <Suggestions storyKey={a.ticketKey} criterion={c.id} items={c.suggestions} /> : null}
                        </td>
                        <td>
                          <span className={`pill ${criterionPill[c.status].cls}`}>{criterionPill[c.status].label}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="callout">
                <Icon name="doc" small />
                <span>{a.note}</span>
              </div>
            </>
          ),
        },
        {
          value: 'cases',
          label: `Proposed UAT cases ${a.proposedCases.length}`,
          content:
            a.proposedCases.length === 0 ? (
              <p className="muted">Every criterion has a passing test, so no UAT cases are proposed.</p>
            ) : (
              <ol className="uatcases">
                {a.proposedCases.map((c) => (
                  <li key={c.id} className="card">
                    <div className="uc-head">
                      <span className="mono">{c.id}</span>
                      <span className="pill">for {c.criterion}</span>
                    </div>
                    <b>{c.title}</b>
                    <ol>
                      {c.steps.map((s, i) => (
                        <li key={i}>{s}</li>
                      ))}
                    </ol>
                  </li>
                ))}
              </ol>
            ),
        },
        { value: 'sources', label: `Sources ${sources.length}`, content: <SourcesList sources={sources} /> },
      ]}
    />
  );
}

function uatAsText(a: UatArtifact) {
  const lines = [a.title, a.subtitle, '', ...a.criteria.map((c) => `${c.id}  ${criterionPill[c.status].label.padEnd(12)}  ${c.text}`)];
  if (a.proposedCases.length) {
    lines.push('', 'Proposed UAT cases', ...a.proposedCases.map((c) => `${c.id}  ${c.title} (${c.criterion})`));
  }
  return lines.join('\n');
}

/**
 * Automated tests of the story's components that look like they cover a criterion. A person decides:
 * Link adds the test to the criterion (the server refuses a test from another repository), and the next
 * analysis counts it if it passed in the target build. A suggestion never counts by itself.
 */
function Suggestions({ storyKey, criterion, items }: { storyKey: string; criterion: string; items: TestSuggestion[] }) {
  const [state, setState] = useState<Record<string, 'busy' | 'linked' | string>>({});
  const link = async (id: string) => {
    setState((x) => ({ ...x, [id]: 'busy' }));
    try {
      await api(`/api/hexa/tests/${id}/links`, { method: 'POST', body: JSON.stringify({ type: 'criterion', ref: `${storyKey}#${criterion}` }) });
      hexaChanged();
      setState((x) => ({ ...x, [id]: 'linked' }));
    } catch (e) {
      setState((x) => ({ ...x, [id]: (e as Error).message }));
    }
  };
  return (
    <div className="suggest" role="group" aria-label={`Tests that may cover ${criterion}`}>
      <span className="suggest-h">
        Possibly covered by <span className="muted">· not counted until a person links it</span>
      </span>
      <ul>
        {items.map((t) => {
          const st = state[t.id];
          return (
            <li key={t.id}>
              <span className="suggest-main">
                <Link to={`/hexa/test/${t.id}?tab=automated`} className="suggest-title">
                  {t.title}
                </Link>
                <small>{t.why}</small>
                {st && st !== 'busy' && st !== 'linked' && (
                  <span className="errtext" role="alert">
                    {st}
                  </span>
                )}
              </span>
              <span className={`pill ${t.result === 'passed' ? 'pass' : t.result === 'failed' ? 'crit' : ''}`}>{t.result ?? 'no result'}</span>
              {st === 'linked' ? (
                <span role="status" className="suggest-linked">
                  Linked · analyse again to count it
                </span>
              ) : (
                <button type="button" className="btn small" onClick={() => void link(t.id)} disabled={st === 'busy'} aria-label={`Link ${t.title} to ${storyKey} ${criterion}`}>
                  {st === 'busy' ? 'Linking…' : 'Link'}
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
