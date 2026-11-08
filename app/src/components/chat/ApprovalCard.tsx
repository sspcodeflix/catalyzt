import { useId } from 'react';

import { Link } from 'react-router-dom';

import type { Approval } from '../../lib/types';
import { Icon } from '../Icon';

interface ApprovalCardProps {
  approval: Approval;
  /** The answer revision this approval belongs to. */
  revision?: number;
  /** Why the approve button is disabled, or null when it can be used. */
  lockReason: string | null;
  busy?: boolean;
  error?: string | null;
  onDecide: (decision: 'approved' | 'declined') => void;
}

const time = (iso?: string) =>
  iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }) : '';

/**
 * Anything that changes something is an approval card. Nothing changes until a person approves,
 * and the server decides: the card shows what it recorded, including who decided and the outcome.
 */
export function ApprovalCard({ approval, revision, lockReason, busy = false, error, onDecide }: ApprovalCardProps) {
  const pending = approval.status === 'pending';
  const gateId = useId();
  const by = approval.decidedBy ? `by ${approval.decidedBy}` : 'by you';
  return (
    <section className="card approve" aria-label="Approval needed" id={approval.id ? `approval-${approval.id}` : undefined} tabIndex={-1}>
      <div className="head">
        <Icon name="hand" />
        {approval.title}
      </div>
      <div className="sub">
        Nothing changes until you approve.
        {revision ? ` · Revision ${revision}` : ''}
      </div>
      <dl>
        {approval.facts.map((f) => (
          <div key={f.label} className="fact">
            <dt>{f.label}</dt>
            <dd className={`${f.mono ? 'mono' : ''}${f.value.includes('\n') ? ' multi' : ''}`.trim() || undefined}>{f.value}</dd>
          </div>
        ))}
      </dl>
      <div className="foot">
        <div className="footinfo">
          <span className="lockline">
            <Icon name="lock" small />
            {approval.credentialNote}
          </span>
          {pending && lockReason && (
            <span className="gatehint" id={gateId}>
              <Icon name="warn" small />
              {lockReason}
            </span>
          )}
        </div>
        {pending ? (
          <div className="actions">
            <button type="button" className="btn plain" onClick={() => onDecide('declined')} disabled={busy || !approval.id}>
              Not now
            </button>
            <button type="button" className="btn ink" disabled={busy || !!lockReason} aria-describedby={lockReason ? gateId : undefined} aria-busy={busy} onClick={() => onDecide('approved')}>
              <Icon name="branch" small />
              {busy ? 'Working…' : approval.actionLabel}
            </button>
          </div>
        ) : approval.status === 'expired' ? (
          <span role="status" className="pill">
            {approval.outcome?.text ?? 'Superseded by a newer answer'}
          </span>
        ) : (
          <span role="status" className={`pill ${approval.status === 'approved' ? 'pass' : ''}`}>
            {approval.status === 'approved' ? 'Approved' : 'Declined'} {by} · {time(approval.decidedAt)}
          </span>
        )}
      </div>
      {error && (
        <div className="outcome bad" role="alert">
          <Icon name="warn" small className="bad" />
          <span>{error}</span>
        </div>
      )}
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
