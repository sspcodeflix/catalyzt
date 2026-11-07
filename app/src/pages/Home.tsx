import { useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { Composer, type ComposerSubmit } from '../components/Composer';
import { HorizonMark } from '../components/HorizonMark';
import { Icon } from '../components/Icon';
import { capabilities, currentUser } from '../lib/data';

const greeting = () => {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
};

export function Home() {
  const navigate = useNavigate();
  const [draft, setDraft] = useState('');

  const start = (msg: ComposerSubmit) => {
    // Until the API exists, a new chat gets a client-side id and carries the first message in router state.
    navigate(`/chat/${crypto.randomUUID()}`, { state: { first: msg } });
  };

  return (
    <div className="home">
      <div className="hero">
        <HorizonMark size={54} />
        <h1>
          {greeting()}, {currentUser.name.split(' ')[0]}
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
          <button key={c.id} type="button" className="cap" onClick={() => setDraft(c.example)}>
            <span className="tile">
              <Icon name={c.icon} />
            </span>
            <b>{c.name}</b>
            <span>{c.summary}</span>
            <em>“{c.example}”</em>
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
