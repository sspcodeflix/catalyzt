import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import { AgentNode } from '../components/chat/RunSummary';
import { Icon } from '../components/Icon';
import { useAgentActivity, useUsage, type AgentActivity, type UsageRow } from '../lib/agentsStore';
import { currentUser } from '../lib/data';
import type { AgentView } from '../lib/types';

type Filter = 'all' | 'running' | 'rejected' | 'failed' | 'mine';

const elapsed = (a: AgentActivity) => {
  const ms = (a.endedAt ? new Date(a.endedAt).getTime() : Date.now()) - new Date(a.startedAt).getTime();
  return Math.max(0, Math.round(ms / 100) / 10);
};

const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

const toView = (a: AgentActivity): AgentView => ({
  id: a.id,
  parentId: a.parentId,
  agent: a.agent,
  kind: a.kind,
  task: a.task,
  state: a.status,
  model: a.model ?? undefined,
  result: a.result ?? a.error ?? undefined,
  tokens: a.tokens ?? undefined,
  seconds: elapsed(a),
  steps: a.steps.map((s) => ({ id: `${a.id}-${s.seq}`, kind: s.kind, label: s.label, detail: s.detail ?? undefined, state: s.status, seconds: 0 })),
});

/** Every agent the Orchestrator spawns, live: who asked, which chat, what each agent is doing. */
export function Agents() {
  const { agents, loaded, error, at } = useAgentActivity();
  const [filter, setFilter] = useState<Filter>('all');

  // Group agent runs into workflow runs (one per request), newest first.
  const runs = useMemo(() => {
    const by = new Map<string, AgentActivity[]>();
    for (const a of agents) by.set(a.workflowRunId, [...(by.get(a.workflowRunId) ?? []), a]);
    return [...by.values()]
      .map((list) => {
        const root = list.find((a) => !a.parentId) ?? list[0];
        // The feed is newest first (by time, then insertion order); reversed, it is spawn order.
        const ordered = [...list].reverse();
        return { id: root.workflowRunId, root, list: ordered, status: root.status };
      })
      .sort((a, b) => b.root.startedAt.localeCompare(a.root.startedAt));
  }, [agents]);

  const running = agents.filter((a) => a.status === 'running' && a.parentId);
  const shown = runs.filter((r) =>
    filter === 'all'
      ? true
      : filter === 'running'
        ? r.status === 'running'
        : filter === 'mine'
          ? r.root.requestedBy.name === currentUser.name
          : r.list.some((a) => a.status === filter),
  );
  const count = (f: Filter) => runs.filter((r) => (f === 'running' ? r.status === 'running' : f === 'mine' ? r.root.requestedBy.name === currentUser.name : f === 'all' ? true : r.list.some((a) => a.status === f))).length;

  return (
    <div className="page">
      <div className="pagehead">
        <h1 className="pagetitle">Agents</h1>
        <p className="muted">
          Every request is handled by an Orchestrator that spawns agents: guards, a router and one specialist. See who
          asked, what each agent was told to do, and what it did. Updates live.
        </p>
      </div>

      <TokenUsage />

      <section aria-labelledby="ag-now" className="card agnow">
        <div className="sechead">
          <h3 id="ag-now">Working now</h3>
          <span role="status">{running.length === 0 ? 'No agents running' : `${running.length} running`}</span>
        </div>
        {running.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>
            Agents appear here while they work. Ask something in a chat to see them spawn.
          </p>
        ) : (
          <ul className="nowlist">
            {running.map((a) => (
              <li key={a.id}>
                <span className="spinner sm" aria-hidden="true" />
                <span className="agent">{a.agent}</span>
                <span className="grow nowtask">{a.task}</span>
                <span className="muted nowwho">
                  for {a.requestedBy.name}
                  {a.chat && (
                    <>
                      {' · '}
                      <Link to={`/chat/${a.chat.id}`}>{a.chat.title}</Link>
                    </>
                  )}
                  {' · '}
                  {elapsed(a)} s
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="tools">
        <span className="segctl" role="radiogroup" aria-label="Show">
          {(['all', 'running', 'rejected', 'failed', 'mine'] as const).map((f) => (
            <button key={f} type="button" role="radio" aria-checked={filter === f} className={filter === f ? 'on' : undefined} onClick={() => setFilter(f)}>
              {f === 'all' ? 'All' : f === 'mine' ? 'Mine' : f[0].toUpperCase() + f.slice(1)} {count(f)}
            </button>
          ))}
        </span>
        <span className="grow" />
        <span className="muted" style={{ fontSize: 12.5 }}>
          {error ? `Could not refresh: ${error}` : at ? `Updated ${time(at)}` : ''}
        </span>
      </div>

      {!loaded ? (
        <p className="muted">Loading…</p>
      ) : shown.length === 0 ? (
        <p className="muted">No runs to show.</p>
      ) : (
        <ol className="runlist">
          {shown.map((r) => (
            <li key={r.id} className="card runcard">
              <div className="runhead">
                <span className="avatar" title={r.root.requestedBy.name}>
                  {r.root.requestedBy.initials}
                </span>
                <div className="grow" style={{ minWidth: 0 }}>
                  <b>{r.root.requestedBy.name}</b>
                  <span className="muted">
                    {r.root.chat ? (
                      <>
                        {' in '}
                        <Link to={`/chat/${r.root.chat.id}`}>{r.root.chat.title}</Link>
                      </>
                    ) : r.list.some((a) => a.kind === 'refiner') ? (
                      ' refined a story'
                    ) : null}
                    {' · '}
                    {time(r.root.startedAt)}
                  </span>
                </div>
                <span className={`pill ${r.status === 'running' ? 'info' : r.status === 'done' ? 'pass' : r.status === 'rejected' ? 'warn' : ''}`}>
                  {r.status === 'running' ? 'Running' : r.status[0].toUpperCase() + r.status.slice(1)}
                </span>
              </div>
              <div className="agenttree">
                <AgentNode agents={r.list.map(toView)} node={toView(r.root)} />
              </div>
            </li>
          ))}
        </ol>
      )}
      <p className="muted" style={{ fontSize: 12.5, display: 'flex', gap: 6, alignItems: 'center' }}>
        <Icon name="lock" small />
        Recorded in the database: workflow_runs, agent_runs and agent_steps. Message text is never stored in a task.
      </p>
    </div>
  );
}

const fmt = (n: number) => n.toLocaleString();

/** Token totals from the ledger (model_calls), so cost can be watched by agent, model and person. */
function TokenUsage() {
  const u = useUsage();
  const [by, setBy] = useState<'byAgent' | 'byModel' | 'byUser' | 'byDay'>('byAgent');
  if (!u) return null;
  const rows: UsageRow[] = u[by];
  const max = Math.max(1, ...rows.map((r) => r.total));
  return (
    <section className="card usage" aria-labelledby="ag-usage">
      <div className="sechead">
        <h3 id="ag-usage">Token usage</h3>
        <span>Every model call is recorded</span>
      </div>
      <div className="usetiles">
        <div className="kpi">
          <b>{fmt(u.today.total)}</b>
          <span>Tokens today · {fmt(u.today.calls)} calls</span>
        </div>
        <div className="kpi">
          <b>{fmt(u.allTime.total)}</b>
          <span>Tokens in total · {fmt(u.allTime.calls)} calls</span>
        </div>
        <div className="kpi">
          <b>{fmt(u.allTime.prompt)}</b>
          <span>Input tokens</span>
        </div>
        <div className="kpi">
          <b>{fmt(u.allTime.completion)}</b>
          <span>Output tokens</span>
        </div>
      </div>
      <div className="tools">
        <span className="segctl" role="radiogroup" aria-label="Break down by">
          {(
            [
              ['byAgent', 'Agent'],
              ['byModel', 'Model'],
              ['byUser', 'Person'],
              ['byDay', 'Day'],
            ] as const
          ).map(([k, l]) => (
            <button key={k} type="button" role="radio" aria-checked={by === k} className={by === k ? 'on' : undefined} onClick={() => setBy(k)}>
              {l}
            </button>
          ))}
        </span>
        {u.allTime.unreported > 0 && <span className="muted" style={{ fontSize: 12.5 }}>{u.allTime.unreported} calls did not report tokens (stopped or failed)</span>}
      </div>
      {rows.length === 0 ? (
        <p className="muted" style={{ margin: 0 }}>No model calls yet. Without DeepSeek configured, Horizon uses rules and spends no tokens.</p>
      ) : (
        <div className="tablewrap">
          <table className="usetable">
            <thead>
              <tr>
                <th>{by === 'byAgent' ? 'Agent' : by === 'byModel' ? 'Model' : by === 'byUser' ? 'Person' : 'Day'}</th>
                <th className="r">Calls</th>
                <th className="r hidem">Input</th>
                <th className="r hidem">Output</th>
                <th className="r">Total</th>
                <th className="hidem" aria-hidden="true" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key}>
                  <td>{r.key}</td>
                  <td className="r">{fmt(r.calls)}</td>
                  <td className="r hidem">{fmt(r.prompt)}</td>
                  <td className="r hidem">{fmt(r.completion)}</td>
                  <td className="r">{fmt(r.total)}</td>
                  <td className="hidem barcell" aria-hidden="true">
                    <i style={{ width: `${(r.total / max) * 100}%` }} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
