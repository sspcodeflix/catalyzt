import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';

import { BrandMark } from '../components/BrandMark';
import { Composer, type ComposerSubmit } from '../components/Composer';
import { Icon } from '../components/Icon';
import { BRAND } from '../lib/brand';
import { capabilities } from '../lib/data';
import { http, sessionEpoch, useSession } from '../lib/session';
import { useTickets } from '../lib/ticketStore';
import { useActiveFlows } from '../lib/flows';
import { FlowCard } from './Flows';

const greeting = () => {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
};

/** What is waiting in the application right now, from the server (GET /api/home). */
interface HomeData {
  pendingApprovals: { id: string; action: string; storyKey: string | null; revision: number; chatId: string; chatTitle: string; askedBy: string }[];
  openDecisions: number;
  stories: number;
  runs: { recent: number; failed: number; latest: { id: string; repo: string | null; status: string; at: string; prNumber: number | null } | null };
  tests: number;
}

export function Home() {
  const navigate = useNavigate();
  // ?ask= puts a prepared request in the message box (a flow's "Draft automation"), for the person to check and send.
  const [params] = useSearchParams();
  const [draft, setDraft] = useState(() => params.get('ask')?.slice(0, 2000) ?? '');
  const flows = useActiveFlows();
  const { me, loaded } = useSession();
  const firstName = me?.user.name.split(' ')[0] ?? '';
  const story = useTickets()[0]?.key;
  const component = me?.app?.components[0]?.name;
  const [home, setHome] = useState<HomeData | null>(null);

  useEffect(() => {
    if (!loaded || !me?.app) return;
    const epoch = sessionEpoch();
    setHome(null);
    http('/api/home')
      .then((r) => (r.ok ? (r.json() as Promise<HomeData>) : null))
      .then((d) => {
        if (d && epoch === sessionEpoch()) setHome(d);
      })
      .catch(() => undefined);
  }, [loaded, me?.app?.id]);

  // Examples name real things in the application when there are any.
  const exampleFor = (id: string, fallback: string) =>
    id === 'analysis' && story ? `Is ${story} ready for UAT?` : id === 'authoring' && story ? `Write tests for ${story}` : id === 'cloudops' && component ? `Why is ${component} restarting?` : id === 'security' && me?.app ? `Fix the critical vulnerabilities in ${me.app.name}` : fallback;

  const start = (msg: ComposerSubmit) => {
    // A new chat gets a client-side id; the server stores it with the first message.
    navigate(`/chat/${crypto.randomUUID()}`, { state: { first: msg } });
  };

  const approval = home?.pendingApprovals[0];
  return (
    <div className="home">
      <div className="hero">
        <BrandMark size={44} />
        <h1>
          {greeting()}
          {firstName ? `, ${firstName}` : ''}
        </h1>
        <p>{BRAND.tagline}</p>
      </div>

      <Composer placeholder="Ask Catalyzt to analyse, write, run, fix or secure" onSubmit={start} value={draft} onValueChange={setDraft} />

      {me?.app && flows && flows.length > 0 && (
        <section className="homeflows" aria-labelledby="homeflows-h">
          <div className="homeflowshead">
            <h2 id="homeflows-h">Test flows in progress</h2>
            <Link to="/flows">All flows</Link>
          </div>
          {flows.slice(0, 3).map((f) => (
            <FlowCard key={f.id} flow={f} compact />
          ))}
        </section>
      )}

      {me?.app && (
        <nav className="entry" aria-label="Start from your work">
          <Link to="/tickets" className="cap">
            <span className="tile">
              <Icon name="doc" />
            </span>
            <b>Analyse a story</b>
            <span>{home ? (home.stories ? `${home.stories} ${home.stories === 1 ? 'story' : 'stories'} in the Jira filter, ready to check against their tests.` : 'No stories in the Jira filter yet. Create one, or widen the filter in Jira Stories.') : 'Loading…'}</span>
          </Link>
          <Link to="/hexa?tab=runs" className="cap">
            <span className="tile">
              <Icon name="play" />
            </span>
            <b>Investigate a failed run</b>
            <span>
              {home
                ? home.runs.recent
                  ? `${home.runs.failed} of the last ${home.runs.recent} runs failed.${home.runs.latest ? ` Latest: ${home.runs.latest.prNumber ? `PR #${home.runs.latest.prNumber}` : 'a run'} on ${home.runs.latest.repo ?? 'an upload'}, ${home.runs.latest.status}.` : ''}`
                  : 'No pipeline runs recorded yet. Push results from CI (docs/hexa-github-action.yml) or upload JUnit XML in Hexa.'
                : 'Loading…'}
            </span>
          </Link>
          <Link to={approval ? `/chat/${approval.chatId}` : '/huddle'} className="cap">
            <span className="tile">
              <Icon name="hand" />
            </span>
            <b>Review a proposed change</b>
            <span>
              {home
                ? [
                    home.pendingApprovals.length ? `${home.pendingApprovals.length} approval${home.pendingApprovals.length === 1 ? '' : 's'} waiting${approval ? ` (${approval.chatTitle}, asked by ${approval.askedBy})` : ''}` : 'No approvals waiting',
                    home.openDecisions ? `${home.openDecisions} decision${home.openDecisions === 1 ? '' : 's'} open in Huddle` : 'nothing open in Huddle',
                  ].join(' · ')
                : 'Loading…'}
            </span>
          </Link>
        </nav>
      )}

      {/* One example per capability, as a short row: a click puts it in the message box to edit or send. The
          capabilities themselves are also in the composer's agent picker. */}
      <section className="tryrow" aria-labelledby="try-label">
        <span id="try-label" className="trylabel">
          Try asking
        </span>
        <ul className="chips">
          {capabilities.map((c) => (
            <li key={c.id}>
              <button type="button" className="chip" title={`${c.name}: ${c.summary}`} onClick={() => setDraft(exampleFor(c.id, c.example))}>
                <Icon name={c.icon} small />
                <span>{exampleFor(c.id, c.example)}</span>
              </button>
            </li>
          ))}
        </ul>
      </section>

      <div className="fine">
        <b>{BRAND.name}</b> · AI Quality &amp; Reliability Engineering
        <br />
        Catalyzt can be wrong. Check its sources. It asks before it changes anything and never sees your credentials.
      </div>
    </div>
  );
}
