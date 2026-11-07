import { Link, useParams } from 'react-router-dom';

import type { Artifact } from '../../lib/types';
import { Icon } from '../Icon';

/** Opens the work product in the side panel at its own URL, so it can be linked from a ticket or PR. */
export function ArtifactCard({ chatId, artifact }: { chatId: string; artifact: Artifact }) {
  const { artifactId } = useParams();
  const open = artifactId === artifact.id;
  return (
    <Link
      to={`/chat/${chatId}/artifact/${artifact.id}`}
      className={`card artifact${open ? ' open' : ''}`}
      aria-current={open ? 'page' : undefined}
    >
      <span className="tile">
        <Icon name={artifact.kind === 'uat' ? 'target' : 'codeic'} />
      </span>
      <span className="grow">
        <b>{artifact.title}</b>
        <span>
          {artifact.cardLabel} · {open ? 'open in the panel' : 'open'}
        </span>
      </span>
      <Icon name="right" small />
    </Link>
  );
}
