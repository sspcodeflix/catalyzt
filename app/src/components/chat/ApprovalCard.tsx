import { useId } from 'react';

import { Link } from 'react-router-dom';

import type { Approval } from '../../lib/types';
import { Icon } from '../Icon';

interface ApprovalCardProps {
  approval: Approval;
  /** True until the answer this approval belongs to has a rating. */
  locked: boolean;
  onDecide: (decision: 'approved' | 'declined') => void;
}

const time = (iso?: string) =>
  iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }) : '';

/** Anything that changes something is an approval card. Nothing changes until a person approves. */
export function ApprovalCard({ approval, locked, onDecide }: ApprovalCardProps) {
  const pending = approval.status === 'pending';
  const gateId = useId();
  return (
    <section className="card approve" aria-label="Approval needed">
      <div className="head">
        <Icon name="hand" />
        {approval.title}
      </div>
      <div className="sub">Nothing changes until you approve.</div>
      <dl>
        {approval.facts.map((f) => (
          <div key={f.label} className="fact">
            <dt>{f.label}</dt>
            <dd className={f.mono ? 'mono' : undefined}>{f.value}</dd>
          </div>
        ))}
      </dl>
      <div className="foot">
        <div className="footinfo">
          <span className="lockline">
            <Icon name="lock" small />
            {approval.credentialNote}
          </span>
          {pending && locked && (
            <span className="gatehint" id={gateId}>
              <Icon name="warn" small />
              Rate the answer to approve
            </span>
          )}
        </div>
        {pending ? (
          <div className="actions">
            <button type="button" className="btn plain" onClick={() => onDecide('declined')}>
              Not now
            </button>
            <button
              type="button"
              className="btn ink"
              disabled={locked}
              aria-describedby={locked ? gateId : undefined}
              onClick={() => onDecide('approved')}
            >
              <Icon name="branch" small />
              {approval.actionLabel}
            </button>
          </div>
        ) : (
          <span role="status" className={`pill ${approval.status === 'approved' ? 'pass' : ''}`}>
            {approval.status === 'approved' ? 'Approved by you' : 'Declined'} · {time(approval.decidedAt)}
          </span>
        )}
      </div>
      {approval.outcome && (
        <div className={`outcome ${approval.outcome.ok ? '' : 'bad'}`} role="status">
          <Icon name={approval.outcome.ok ? 'check' : 'warn'} small className={approval.outcome.ok ? 'ok' : 'bad'} />
          <span>{approval.outcome.text}</span>
          {approval.outcome.ok && approval.action === 'add_uat_cases' && (
            <Link to="/hexa?tab=manual" className="linkbtn">
              Open in Hexa
            </Link>
          )}
        </div>
      )}
    </section>
  );
}
