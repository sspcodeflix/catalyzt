import { useId, useState } from 'react';

import type { AgentView, RunStep } from '../../lib/types';
import { Icon } from '../Icon';

interface RunSummaryProps {
  summary: string;
  steps: RunStep[];
  /** The agent tree for answers produced by the agent workflow. */
  agents?: AgentView[];
  live?: boolean;
}

/**
 * While an answer is being produced, the agents show live as the Orchestrator spawns them. A
 * finished run collapses to one line; expanding it shows each agent with its task and steps.
 */
export function RunSummary({ summary, steps, agents, live }: RunSummaryProps) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const list = agents ?? [];
  const failed = list.length ? list.some((a) => a.state === 'failed') : steps.some((s) => s.state === 'failed');
  const rejected = list.some((a) => a.state === 'rejected');
  const working = [...list].reverse().find((a) => a.state === 'running' && a.parentId);
  const current = steps.find((s) => s.state === 'running');
  const expanded = live || open;
  const bad = failed || rejected;

  return (
    <>
      {live ? (
        <div className="runrow" role="status">
          <span className="spinner sm" aria-hidden="true" />
          {working ? (
            <>
              <span className="agent">{working.agent}</span>
              {working.task}…
            </>
          ) : current ? (
            `${current.label}…`
          ) : (
            `${summary}…`
          )}
        </div>
      ) : (
        <button type="button" className="runrow ghost" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
          <Icon name={bad ? 'warn' : 'check'} small className={bad ? 'bad' : 'ok'} />
          {summary}
          {list.length > 0 && <span className="muted">· {list.filter((a) => a.parentId).length} agents</span>}
          <Icon name="down" small className={open ? 'flip' : undefined} />
        </button>
      )}
      {expanded &&
        (list.length ? (
          <div id={id} className="card agenttree" aria-label="Agents in this answer">
            <AgentNode agents={list} node={list.find((a) => !a.parentId) ?? list[0]} />
          </div>
        ) : (
          <div id={id} className="card steps">
            {steps.map((s, i) => (
              <div key={i} className="step">
                <StateIcon state={s.state ?? 'done'} />
                <div>
                  {s.agent && <span className="agent">{s.agent}</span>}
                  {s.label}
                  {s.noModel && <span className="tag">no model</span>}
                  {s.detail && <small>{s.detail}</small>}
                </div>
                <time>{s.state === 'running' ? '' : `${s.seconds} s`}</time>
              </div>
            ))}
          </div>
        ))}
    </>
  );
}

function StateIcon({ state }: { state: string }) {
  if (state === 'running') return <span className="spinner sm" aria-label="Running" />;
  if (state === 'failed' || state === 'rejected') return <Icon name="warn" small className="bad" />;
  if (state === 'stopped') return <Icon name="stop" small className="muted" />;
  return <Icon name="check" small className="ok" />;
}

const STATE_LABEL: Record<AgentView['state'], string> = {
  running: 'Working',
  done: 'Done',
  failed: 'Failed',
  rejected: 'Rejected',
  stopped: 'Stopped',
};

export function AgentNode({ agents, node }: { agents: AgentView[]; node: AgentView }) {
  const children = agents.filter((a) => a.parentId === node.id);
  return (
    <div className={`anode${node.parentId ? '' : ' root'}`}>
      <div className="arow">
        <StateIcon state={node.state} />
        <div className="amain">
          <div className="ahead">
            <span className="agent">{node.agent}</span>
            <span className="atask">{node.task}</span>
          </div>
          <small>
            {STATE_LABEL[node.state]}
            {node.result && node.state !== 'running' ? `: ${node.result}` : ''}
            {node.model ? ` · ${node.model}` : node.parentId ? ' · no model' : ''}
            {node.tokens ? ` · ${node.tokens.toLocaleString()} tokens` : ''}
          </small>
          {node.steps.length > 0 && node.parentId && (
            <ol className="asteps">
              {node.steps.map((s) => (
                <li key={s.id}>
                  <StateIcon state={s.state} />
                  <span>
                    {s.label}
                    <span className="tag">{s.kind}</span>
                    {s.detail && <small>{s.detail}</small>}
                  </span>
                  <time>{s.state === 'running' ? '' : `${s.seconds} s`}</time>
                </li>
              ))}
            </ol>
          )}
        </div>
        <time>{node.state === 'running' ? '' : `${node.seconds} s`}</time>
      </div>
      {children.length > 0 && (
        <div className="achildren" aria-label={`Spawned by ${node.agent}`}>
          {children.map((c) => (
            <AgentNode key={c.id} agents={agents} node={c} />
          ))}
        </div>
      )}
    </div>
  );
}
