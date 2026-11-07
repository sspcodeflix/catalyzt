import * as Tabs from '@radix-ui/react-tabs';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';

import { Icon } from '../components/Icon';
import {
  statusLabel,
  syncSource,
  testQuestion,
  useContextStore,
  type RankedChunk,
} from '../lib/contextData';

/** Side panel for one source: test a question against the app's context, and the source's details. */
export function ContextSourcePanel() {
  // Remount per source so the question and results never carry over.
  const { sourceId } = useParams();
  return <SourcePanel key={sourceId} sourceId={sourceId} />;
}

function SourcePanel({ sourceId }: { sourceId: string | undefined }) {
  const { sources } = useContextStore();
  const source = sources.find((s) => s.id === sourceId);
  const ref = useRef<HTMLElement>(null);

  const [question, setQuestion] = useState(source?.type === 'Fabric' ? 'What is the refund window for partial refunds?' : '');
  const [results, setResults] = useState<RankedChunk[] | null>(null);
  const qId = useId();

  // Below 900px the panel stacks under the list, so bring it into view when it opens.
  useEffect(() => {
    if (window.matchMedia('(max-width: 899px)').matches) ref.current?.scrollIntoView({ block: 'start' });
  }, [sourceId]);

  const close = (
    <Link to="/context" className="icon" aria-label="Close panel">
      <Icon name="close" />
    </Link>
  );

  if (!source) {
    return (
      <section ref={ref} className="panel" aria-label="Not found">
        <div className="phead">
          <div className="t">
            <b>Not found</b>
            <span>This source doesn't exist or you don't have access.</span>
          </div>
          {close}
        </div>
      </section>
    );
  }

  const run = (e: FormEvent) => {
    e.preventDefault();
    setResults(testQuestion(question));
  };

  const st = statusLabel[source.status];
  const canSync = source.type === 'Fabric' || source.type === 'Confluence' || source.type === 'Jira';

  return (
    <section ref={ref} className="panel" aria-label={source.title}>
      <div className="phead">
        <div className="t">
          <b>{source.title}</b>
          <span>
            {source.readOnly ? 'Read only · v14 · ' : ''}
            {source.updated} · {source.content}
          </span>
        </div>
        {canSync && (
          <button type="button" className="ghost" onClick={() => syncSource(source.id)}>
            <Icon name="retry" small />
            Sync now
          </button>
        )}
        {close}
      </div>

      <Tabs.Root defaultValue="test" className="pbody" style={{ gap: 20 }}>
        <Tabs.List className="tabs" aria-label="Views">
          <Tabs.Trigger value="test">Test a question</Tabs.Trigger>
          <Tabs.Trigger value="details">Details</Tabs.Trigger>
        </Tabs.List>

        <Tabs.Content value="test" className="tabpane" style={{ gap: 16 }}>
          <form onSubmit={run} className="field-row">
            <div className="field" style={{ height: 44 }}>
              <Icon name="search" small />
              <label htmlFor={qId} className="sr">
                Question
              </label>
              <input
                id={qId}
                type="search"
                placeholder="Type a question to see which chunks Horizon would use"
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
              />
            </div>
            <button type="submit" className="btn ink" style={{ height: 44 }} disabled={!question.trim()}>
              Test
            </button>
          </form>

          {results && (
            <div aria-live="polite" className="tabpane" style={{ gap: 12 }}>
              <div className="sechead" style={{ margin: 0 }}>
                <h3>What Horizon would use</h3>
                <span>
                  Top {results.length} across all {sources.length} sources · relevance, not correctness
                </span>
              </div>
              {results.length === 0 && <p className="muted">Nothing in this app's context matches that question.</p>}
              {results.map((c) => (
                <div key={c.where} className="chunk">
                  <header>
                    <span>{c.where}</span>
                    <span className="rel">relevance {c.relevance.toFixed(2)}</span>
                  </header>
                  <div>{c.text}</div>
                  <div>
                    <span className={`pill ${c.used ? 'pass' : 'warn'}`}>{c.used ? 'Used' : c.reason}</span>
                  </div>
                </div>
              ))}
            </div>
          )}

          {source.readOnly && (
            <div className="callout">
              <Icon name="lock" small />
              <span>
                The Fabric is the source of truth and is never edited from Horizon. To correct it, raise it with the
                Fabric owners; to add team knowledge, upload it here.
              </span>
            </div>
          )}
        </Tabs.Content>

        <Tabs.Content value="details" className="tabpane">
          <dl className="details">
            <dt>Type</dt>
            <dd>{source.type}</dd>
            <dt>Location</dt>
            <dd className="mono">{source.sub}</dd>
            <dt>Scope</dt>
            <dd>{source.scope === 'App' ? 'Whole app' : source.scope}</dd>
            <dt>Trust</dt>
            <dd>{source.trust}</dd>
            <dt>Status</dt>
            <dd>
              <span className={`pill ${st.tone}`}>{st.label}</span>
              {source.failReason && <span className="failreason">{source.failReason}</span>}
            </dd>
            {!!source.excludedChunks && (
              <>
                <dt>Excluded</dt>
                <dd>{source.excludedChunks} chunks, until the conflict is decided in Huddle</dd>
              </>
            )}
            <dt>Content</dt>
            <dd>{source.content}</dd>
            <dt>Updated</dt>
            <dd>{source.updated}</dd>
            {source.addedBy && (
              <>
                <dt>Added by</dt>
                <dd>{source.addedBy}</dd>
              </>
            )}
          </dl>
        </Tabs.Content>
      </Tabs.Root>
    </section>
  );
}
