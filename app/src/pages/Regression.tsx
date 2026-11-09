import { useEffect, useState } from 'react';

import { Icon } from '../components/Icon';
import type { Capability, CapabilityCheck, CapabilityMap, CheckStatus } from '../lib/capabilityTypes';
import { api, hexaChanged } from '../lib/hexa';
import { sessionEpoch, useSession } from '../lib/session';

const STATUS: Record<CheckStatus, { cls: string; label: string }> = {
  covered: { cls: 'pass', label: 'Covered' },
  failing: { cls: 'crit', label: 'Failing' },
  'not-run': { cls: 'warn', label: 'Not run' },
  none: { cls: '', label: 'No test' },
};

const when = (iso: string) => new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

/**
 * Regression starts here (docs/FLOWS.md › Regression): what the application does, as capabilities with the
 * checks a UI test can verify, drawn from App Context by the agent and edited by people; against it, which
 * checks a passing automated test proves and which are gaps. Route /regression.
 */
export function Regression() {
  const { me, loaded } = useSession();
  const [map, setMap] = useState<CapabilityMap | null>(null);
  const [error, setError] = useState('');
  const [mapping, setMapping] = useState(false);
  const [mapNote, setMapNote] = useState('');
  const app = me?.app;

  useEffect(() => {
    if (!loaded || !app) return;
    const epoch = sessionEpoch();
    let live = true;
    const load = () =>
      api<CapabilityMap>('/api/capabilities')
        .then((m) => live && epoch === sessionEpoch() && setMap(m))
        .catch((e) => live && setError((e as Error).message));
    void load();
    window.addEventListener('hexa:changed', load);
    return () => {
      live = false;
      window.removeEventListener('hexa:changed', load);
    };
  }, [loaded, app?.id, me?.user.id]);

  const reload = () => hexaChanged();
  const run = async (path: string, body: unknown, method = 'POST') => {
    setError('');
    try {
      const m = await api<CapabilityMap>(path, { method, body: JSON.stringify(body) });
      if (m && 'capabilities' in m) setMap(m);
      else reload();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const mapNow = async () => {
    setMapping(true);
    setError('');
    setMapNote('');
    try {
      const r = await api<{ summary: string; map: CapabilityMap }>('/api/capabilities/map', { method: 'POST', body: '{}' });
      setMap(r.map);
      setMapNote(r.summary);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setMapping(false);
    }
  };

  const t = map?.totals;
  const n = map?.capabilities.length ?? 0;
  return (
    <div className="body panelpage">
      <div className="chatcol listcol">
        <div className="page">
          <div className="pagehead withaction">
            <div>
              <h1 className="pagetitle">Regression</h1>
              <p className="muted">
                What {app?.name ?? 'the application'} does, as capabilities with the checks a UI test can verify. The agent draws them from App Context; you edit and confirm them. A check counts as covered once an automated test you
                linked to it passed in the automation repository&apos;s newest merged build. Everything else is a gap to close.
              </p>
            </div>
            <button type="button" className="btn ink" disabled={mapping || !app} onClick={() => void mapNow()}>
              <Icon name={mapping ? 'retry' : 'plus'} small />
              {mapping ? 'Reading App Context…' : n ? 'Map again from App Context' : 'Map from App Context'}
            </button>
          </div>
          {error && (
            <p className="errtext" role="alert">
              {error}
            </p>
          )}
          {mapNote && (
            <p className="muted small" role="status">
              {mapNote}
            </p>
          )}

          {map && t && (
            <section className="card capsummary" aria-label="Coverage of the capability map">
              <div className="captiles">
                <div>
                  <b>{n}</b>
                  <span>capabilities</span>
                </div>
                <div>
                  <b>{t.checks}</b>
                  <span>checks</span>
                </div>
                <div className="pass">
                  <b>{t.covered}</b>
                  <span>covered</span>
                </div>
                <div className="warn">
                  <b>{t.failing + t['not-run']}</b>
                  <span>linked, not passing</span>
                </div>
                <div className="crit">
                  <b>{t.none}</b>
                  <span>no test</span>
                </div>
              </div>
              <p className="muted small">
                {map.build ? `Results from ${map.build.label}, ${when(map.build.at)}.` : 'No build of the automation repository has reported yet: nothing can count as covered until one does.'}
                {map.mappedAt ? ` Mapped from App Context ${when(map.mappedAt)}${map.mappedBy ? ` for ${map.mappedBy}` : ''}.` : ''}
                {n > 0 && (map.confirmed ? ' The map is confirmed.' : ' Not confirmed yet: read the capabilities, fix what is wrong, then confirm.')}
              </p>
              {n > 0 && !map.confirmed && (
                <div className="row">
                  <button type="button" className="btn" onClick={() => void run('/api/capabilities/confirm', {})}>
                    Confirm this map
                  </button>
                </div>
              )}
            </section>
          )}

          {map && n === 0 && !mapping && <p className="muted">No capabilities yet. Map them from App Context, or add one below.</p>}
          {map?.capabilities.map((c) => <CapabilityCard key={c.id} cap={c} components={app?.components.map((x) => x.name) ?? []} run={run} />)}
          {map && <AddCapability components={app?.components.map((x) => x.name) ?? []} run={run} />}
        </div>
      </div>
    </div>
  );
}

function CapabilityCard({ cap, components, run }: { cap: Capability; components: string[]; run: (path: string, body: unknown) => Promise<void> }) {
  const [text, setText] = useState('');
  const [removing, setRemoving] = useState(false);
  const total = cap.checks.length;
  return (
    <article className="card capcard" id={`cap-${cap.id}`}>
      <header className="caphead">
        <div className="capname">
          <h2>{cap.name}</h2>
          {cap.summary && <p className="muted">{cap.summary}</p>}
        </div>
        <div className="capmeta">
          <label className="capcomp">
            <span className="muted small">Tests folder</span>
            <select value={cap.component ?? ''} onChange={(e) => void run(`/api/capabilities/${cap.id}`, { component: e.target.value || null })} aria-label={`Component of ${cap.name}`}>
              <option value="">none</option>
              {components.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
          <span className="pill" title={cap.origin === 'agent' ? `From App Context${cap.sources.length ? `: ${cap.sources.slice(0, 3).join(', ')}` : ''}` : 'Added by a person'}>
            {cap.origin === 'agent' ? 'from App Context' : 'added by a person'}
          </span>
          {cap.confirmedAt ? <span className="pill pass">Confirmed by {cap.confirmedBy}</span> : <span className="pill warn">Not confirmed</span>}
          <span className="pill">
            {cap.counts.covered} of {total} covered
          </span>
          {removing ? (
            <span className="row">
              <span className="muted small">Remove {cap.name}?</span>
              <button type="button" className="btn small" onClick={() => void run(`/api/capabilities/${cap.id}`, { remove: true })}>
                Remove
              </button>
              <button type="button" className="btn small plain" onClick={() => setRemoving(false)}>
                Keep
              </button>
            </span>
          ) : (
            <button type="button" className="btn small plain" onClick={() => setRemoving(true)}>
              Remove
            </button>
          )}
        </div>
      </header>
      <ul className="checks">
        {cap.checks.map((k) => (
          <CheckRow key={k.id} check={k} run={run} />
        ))}
        {cap.checks.length === 0 && <li className="muted">No checks yet.</li>}
      </ul>
      <form
        className="addcheck"
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim().length < 8) return;
          void run(`/api/capabilities/${cap.id}/checks`, { add: text }).then(() => setText(''));
        }}
      >
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Add a check: one behaviour a UI test can verify…" aria-label={`Add a check to ${cap.name}`} maxLength={220} />
        <button type="submit" className="btn small" disabled={text.trim().length < 8}>
          Add check
        </button>
      </form>
    </article>
  );
}

function CheckRow({ check, run }: { check: CapabilityCheck; run: (path: string, body: unknown) => Promise<void> }) {
  const s = STATUS[check.status];
  return (
    <li className={`check ${check.status}`}>
      <span className={`pill ${s.cls}`}>{s.label}</span>
      <span className="checktext">
        {check.text}
        <button type="button" className="btn small plain removecheck" onClick={() => void run(`/api/capabilities/checks/${check.id}`, { remove: true })} aria-label={`Remove the check "${check.text}"`}>
          Remove
        </button>
      </span>
      {(check.tests.length > 0 || check.suggestions.length > 0) && (
        <ul className="checktests">
          {check.tests.map((t) => (
            <li key={t.id}>
              <span className="tname">{t.title}</span>
              <span className={`pill ${t.result === 'passed' ? 'pass' : t.result === 'failed' ? 'crit' : ''}`}>{t.result ?? 'no result in the target build'}</span>
              <button type="button" className="btn small plain" onClick={() => void run(`/api/capabilities/checks/${check.id}/tests`, { testId: t.id, remove: true })}>
                Unlink
              </button>
            </li>
          ))}
          {check.suggestions.map((t) => (
            <li key={t.id} className="suggestion">
              <span className="tname">
                {t.title}
                <small className="muted"> · may already check this: {t.why}</small>
              </span>
              <span className={`pill ${t.result === 'passed' ? 'pass' : t.result === 'failed' ? 'crit' : ''}`}>{t.result ?? 'no result'}</span>
              <button type="button" className="btn small" onClick={() => void run(`/api/capabilities/checks/${check.id}/tests`, { testId: t.id })} title="Makes this test the evidence for the check: its CI result then counts.">
                Use this test
              </button>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

function AddCapability({ components, run }: { components: string[]; run: (path: string, body: unknown) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [summary, setSummary] = useState('');
  const [component, setComponent] = useState('');
  const [checks, setChecks] = useState('');
  if (!open)
    return (
      <button type="button" className="btn" onClick={() => setOpen(true)}>
        <Icon name="plus" small />
        Add a capability
      </button>
    );
  return (
    <form
      className="card addcap"
      onSubmit={(e) => {
        e.preventDefault();
        void run('/api/capabilities', { name, summary, component: component || null, checks: checks.split('\n').map((x) => x.trim()).filter(Boolean) }).then(() => {
          setOpen(false);
          setName('');
          setSummary('');
          setChecks('');
        });
      }}
    >
      <h2>Add a capability</h2>
      <label>
        Name
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} required placeholder="Jira Stories" />
      </label>
      <label>
        One sentence
        <input value={summary} onChange={(e) => setSummary(e.target.value)} maxLength={240} placeholder="The backlog, with each story's UAT state." />
      </label>
      <label>
        Tests folder
        <select value={component} onChange={(e) => setComponent(e.target.value)}>
          <option value="">none</option>
          {components.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </label>
      <label>
        Checks, one per line
        <textarea rows={4} value={checks} onChange={(e) => setChecks(e.target.value)} placeholder={'The list shows every story of the Jira filter with its UAT state\nThe Signed off filter lists only signed-off stories'} />
      </label>
      <div className="row">
        <button type="submit" className="btn ink" disabled={!name.trim()}>
          Add
        </button>
        <button type="button" className="btn plain" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </form>
  );
}
