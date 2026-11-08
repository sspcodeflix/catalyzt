import * as Dropdown from '@radix-ui/react-dropdown-menu';
import { useMatch } from 'react-router-dom';

import { useChat, useRecentChats } from '../lib/chatStore';
import { selectApp, selectWorkspace, useSession } from '../lib/session';
import { useTheme } from '../lib/useTheme';
import { BrandMark } from './BrandMark';
import { Icon } from './Icon';

interface TopBarProps {
  onOpenSidebar: () => void;
}

/** The top bar: the chat title, the application and workspace every page is scoped to, and the theme. */
export function TopBar({ onOpenSidebar }: TopBarProps) {
  const { theme, toggle } = useTheme();
  const chat = useMatch('/chat/:chatId/*');
  const chatId = chat?.params.chatId;
  const loaded = useChat(chatId);
  const recents = useRecentChats();
  const title = chatId ? (loaded?.title ?? recents.find((r) => r.id === chatId)?.title ?? 'New chat') : '';

  return (
    <header className="top">
      <button className="icon menu" aria-label="Open sidebar" onClick={onOpenSidebar}>
        <Icon name="menu" />
      </button>
      <span className="mbrand">
        <BrandMark size={22} label="Catalyzt" />
      </span>
      <div className="title">{title}</div>
      <ScopeSwitcher />
      <button className="icon" aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'} onClick={toggle}>
        <Icon name={theme === 'dark' ? 'sun' : 'moon'} />
      </button>
    </header>
  );
}

/**
 * The application and workspace in the global chrome: readable names first, ids second. Every
 * page's data and actions follow this choice (the server scopes by it).
 */
function ScopeSwitcher() {
  const { me, workspace, loaded, error } = useSession();
  const app = me?.app;
  if (!loaded) return <span className="scope muted">Loading…</span>;
  if (!app) return <span className="scope muted">{error ?? 'No application'}</span>;
  const ws = workspace ?? app.workspaces[0] ?? '';
  const canSwitchApp = (me?.apps.length ?? 0) > 1;
  const canSwitchWs = app.workspaces.length > 1;
  const label = (
    <>
      <Icon name="layers" small />
      <span className="scopename">
        <span className="scopeline">
          <b>{app.name}</b>
          {ws && <span className="muted"> · {ws}</span>}
        </span>
        <small className="mono muted">
          {app.id}
          {ws ? ` / ${ws}` : ''}
        </small>
      </span>
    </>
  );
  if (!canSwitchApp && !canSwitchWs) {
    return (
      <span className="scope" aria-label={`Application ${app.name} (${app.id})${ws ? `, workspace ${ws}` : ''}`}>
        {label}
      </span>
    );
  }
  return (
    <Dropdown.Root>
      <Dropdown.Trigger asChild>
        <button type="button" className="scope pick">
          {label}
          <span className="sr">. Change application or workspace</span>
          <Icon name="down" small />
        </button>
      </Dropdown.Trigger>
      <Dropdown.Portal>
        <Dropdown.Content className="menu-content wide-menu" sideOffset={6} align="end">
          {canSwitchApp && (
            <>
              <Dropdown.Label className="menu-label">Application</Dropdown.Label>
              <Dropdown.RadioGroup value={app.id} onValueChange={(v) => void selectApp(v)}>
                {me!.apps.map((a) => (
                  <Dropdown.RadioItem key={a.id} value={a.id} className="menu-item">
                    <span>
                      {a.name}
                      <span className="menu-hint mono">{a.id}</span>
                    </span>
                    <Dropdown.ItemIndicator className="menu-check">
                      <Icon name="check" small />
                    </Dropdown.ItemIndicator>
                  </Dropdown.RadioItem>
                ))}
              </Dropdown.RadioGroup>
            </>
          )}
          {canSwitchApp && canSwitchWs && <Dropdown.Separator className="menu-sep" />}
          {canSwitchWs && (
            <>
              <Dropdown.Label className="menu-label">Workspace</Dropdown.Label>
              <Dropdown.RadioGroup value={ws} onValueChange={(v) => selectWorkspace(v)}>
                {app.workspaces.map((w) => (
                  <Dropdown.RadioItem key={w} value={w} className="menu-item">
                    <span className="mono">{w}</span>
                    <Dropdown.ItemIndicator className="menu-check">
                      <Icon name="check" small />
                    </Dropdown.ItemIndicator>
                  </Dropdown.RadioItem>
                ))}
              </Dropdown.RadioGroup>
            </>
          )}
        </Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
  );
}
