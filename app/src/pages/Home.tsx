import { useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { Composer, type ComposerSubmit } from '../components/Composer';
import { HorizonMark } from '../components/HorizonMark';
import { Icon } from '../components/Icon';
import { capabilities } from '../lib/data';
import { useSession } from '../lib/session';
import { useTickets } from '../lib/ticketStore';

const greeting = () => {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
};

export function Home() {
  const navigate = useNavigate();
  const [draft, setDraft] = useState('');
  const { me } = useSession();
  const firstName = me?.user.name.split(' ')[0] ?? '';
  const story = useTickets()[0]?.key;
  const component = me?.app?.components[0]?.name;
  // Examples name real things in the application when there are any.
  const exampleFor = (id: string, fallback: string) =>
    id === 'analysis' && story ? `Is ${story} ready for UAT?` : id === 'authoring' && story ? `Write tests for ${story}` : id === 'cloudops' && component ? `Why is ${component} restarting?` : id === 'security' && me?.app ? `Fix the critical vulnerabilities in ${me.app.name}` : fallback;

  const start = (msg: ComposerSubmit) => {
    // Until the API exists, a new chat gets a client-side id and carries the first message in router state.
    navigate(`/chat/${crypto.randomUUID()}`, { state: { first: msg } });
  };

  return (
    <div className="home">
      <div className="hero">
        <HorizonMark size={54} />
        <h1>
          {greeting()}{firstName ? `, ${firstName}` : ''}
        </h1>
        <p>What should we assure today?</p>
      </div>

      <Composer
        placeholder="Ask Horizon to analyse, write, run, fix or secure"
        onSubmit={start}
        value={draft}
        onValueChange={setDraft}
      />

      <div className="caps">
        {capabilities.map((c) => (
          <button key={c.id} type="button" className="cap" onClick={() => setDraft(exampleFor(c.id, c.example))}>
            <span className="tile">
              <Icon name={c.icon} />
            </span>
            <b>{c.name}</b>
            <span>{c.summary}</span>
            <em>“{exampleFor(c.id, c.example)}”</em>
          </button>
        ))}
      </div>

      <div className="fine">
        <b>Horizon</b> · AI Quality &amp; Reliability Engineering
        <br />
        Horizon can be wrong. Check its sources. It asks before it changes anything and never sees your credentials.
      </div>
    </div>
  );
}
