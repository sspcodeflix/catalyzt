import { useEffect, useRef } from 'react';
import { Link, useParams } from 'react-router-dom';

import { Icon } from '../components/Icon';
import { FlowBody } from './Flows';

/**
 * A test flow in the chat's side pane (/chat/:chatId/flow/:flowId): the whole flow, with every control,
 * worked without leaving the chat. The full page at /flows/:flowId shows the same.
 */
export function FlowPanel() {
  const { chatId, flowId } = useParams();
  const ref = useRef<HTMLElement>(null);
  // Below 900px the panel stacks under the chat, so bring it into view when it opens.
  useEffect(() => {
    if (window.matchMedia('(max-width: 899px)').matches) ref.current?.scrollIntoView({ block: 'start' });
  }, [flowId]);
  return (
    <section ref={ref} className="panel flowpanel" aria-label="Test flow">
      <div className="phead">
        <div className="t">
          <b>Test flow</b>
          <span>Everything here acts on the flow itself.</span>
        </div>
        <Link to={`/flows/${flowId}`} className="ghost hidem">
          <Icon name="doc" small />
          Full page
        </Link>
        <Link to={`/chat/${chatId}`} className="icon" aria-label="Close panel">
          <Icon name="close" />
        </Link>
      </div>
      <div className="flowbody">{flowId && <FlowBody flowId={flowId} />}</div>
    </section>
  );
}
