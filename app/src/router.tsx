import { createBrowserRouter } from 'react-router-dom';

import { AppShell } from './components/AppShell';
import { Agents } from './pages/Agents';
import { AppContext } from './pages/AppContext';
import { ArtifactPanel } from './pages/ArtifactPanel';
import { FlowPanel } from './pages/FlowPanel';
import { Regression } from './pages/Regression';
import { ContextSourcePanel } from './pages/ContextSourcePanel';
import { Huddle } from './pages/Huddle';
import { HuddleItemPanel } from './pages/HuddleItemPanel';
import { Chat } from './pages/Chat';
import { FlowDetail, Flows, FlowStart } from './pages/Flows';
import { Hexa } from './pages/Hexa';
import { HexaTestPanel, HexaUpload } from './pages/HexaPanels';
import { Home } from './pages/Home';
import { Search } from './pages/Search';
import { StoryCreate } from './pages/StoryCreate';
import { TicketPanel } from './pages/TicketPanel';
import { Tickets } from './pages/Tickets';

export const router = createBrowserRouter([
  {
    element: <AppShell />,
    children: [
      { index: true, element: <Home /> },
      {
        path: 'chat/:chatId',
        element: <Chat />,
        // The side panel has its own URL so a report or script can be linked from a ticket or PR.
        children: [
          { path: 'artifact/:artifactId', element: <ArtifactPanel /> },
          // A test flow worked in the side pane, without leaving the chat.
          { path: 'flow/:flowId', element: <FlowPanel /> },
        ],
      },
      { path: 'search', element: <Search /> },
      { path: 'flows', element: <Flows /> },
      { path: 'flows/new', element: <FlowStart /> },
      { path: 'flows/:flowId', element: <FlowDetail /> },
      { path: 'regression', element: <Regression /> },
      {
        path: 'hexa',
        element: <Hexa />,
        children: [
          { path: 'upload', element: <HexaUpload /> },
          { path: 'test/:testId', element: <HexaTestPanel /> },
        ],
      },
      { path: 'agents', element: <Agents /> },
      {
        path: 'tickets',
        element: <Tickets />,
        children: [
          { path: 'new', element: <StoryCreate /> },
          { path: ':ticketKey', element: <TicketPanel /> },
        ],
      },
      { path: 'context', element: <AppContext />, children: [{ path: 'source/:sourceId', element: <ContextSourcePanel /> }] },
      { path: 'huddle', element: <Huddle />, children: [{ path: ':itemId', element: <HuddleItemPanel /> }] },
    ],
  },
]);
