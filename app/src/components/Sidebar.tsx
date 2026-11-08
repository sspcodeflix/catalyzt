import * as Dropdown from '@radix-ui/react-dropdown-menu';
import { useEffect, useRef } from 'react';
import { NavLink } from 'react-router-dom';

import { useAgentActivity } from '../lib/agentsStore';
import { useRecentChats } from '../lib/chatStore';
import { useHuddle } from '../lib/huddleData';
import { selectApp, signInAs, useSession } from '../lib/session';
import { useTickets } from '../lib/ticketStore';
import { BrandMark, BrandWordmark } from './BrandMark';
import { Icon } from './Icon';

interface SidebarProps {
  open: boolean;
  onClose: () => void;
}

const navClass = ({ isActive }: { isActive: boolean }) => (isActive ? 'on' : undefined);

const ROLE_LABEL: Record<string, string> = { app_owner: 'App owner', component_manager: 'Component manager', security_champion: 'Security champion', member: 'Member' };
const roleOf = (roles: string[]) => ROLE_LABEL[roles.find((r) => r !== 'member') ?? 'member'];

export function Sidebar({ open, onClose }: SidebarProps) {
  const session = useSession();
  const me = session.me;
  const runningAgents = useAgentActivity().agents.filter((a) => a.status === 'running' && a.parentId).length;
  const openHuddleItems = useHuddle().filter((i) => !i.decision).length;
  const waiting = useTickets().filter((t) => t.uat.state === 'not-analysed').length;
  const recents = useRecentChats();
  const ref = useRef<HTMLElement>(null);

  // As a drawer (below 900px) the sidebar is modal: focus moves in, Tab stays inside, and focus
  // returns to whatever opened it when it closes. Escape and the inert background are the shell's.
  useEffect(() => {
    const aside = ref.current;
    if (!open || !aside) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusables = () => [...aside.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])')].filter((el) => el.offsetParent !== null);
    (aside.querySelector<HTMLElement>('.drawer-close') ?? focusables()[0])?.focus();
    const trap = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const f = focusables();
      if (f.length === 0) return;
      const first = f[0];
      const last = f[f.length - 1];
      if (e.shiftKey && (document.activeElement === first || !aside.contains(document.activeElement))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (document.activeElement === last || !aside.contains(document.activeElement))) {
        e.preventDefault();
        first.focus();
      }
    };
    aside.addEventListener('keydown', trap);
    return () => {
      aside.removeEventListener('keydown', trap);
      opener?.focus();
    };
  }, [open]);

  return (
    <aside ref={ref} className={`sidebar${open ? ' open' : ''}`} aria-label="Catalyzt" role={open ? 'dialog' : undefined} aria-modal={open ? true : undefined}>
      <div className="brandrow">
        <span className="brand">
          <BrandMark size={26} />
          <BrandWordmark />
        </span>
        <button className="icon drawer-close" aria-label="Close sidebar" onClick={onClose}>
          <Icon name="close" />
        </button>
      </div>

      <nav className="nav">
        <NavLink to="/" end className={navClass}>
          <Icon name="edit" />
          New chat
        </NavLink>
        <NavLink to="/search" className={navClass}>
          <Icon name="search" />
          Search
        </NavLink>

        <div className="group" id="nav-testing">
          Testing
        </div>
        <div role="group" aria-labelledby="nav-testing">
          <NavLink to="/tickets" className={navClass}>
            <Icon name="doc" />
            Jira Stories
            {waiting > 0 && (
              <span className="navcount" aria-label={`${waiting} not analysed`}>
                {waiting}
              </span>
            )}
          </NavLink>
          <NavLink to="/hexa" className={navClass}>
            <Icon name="hex" />
            Hexa · Tests
          </NavLink>
        </div>

        <div className="group" id="nav-workspace">
          Workspace
        </div>
        <div role="group" aria-labelledby="nav-workspace">
          <NavLink to="/agents" className={navClass}>
            <Icon name="auto" />
            Agents
            {runningAgents > 0 && (
              <span className="navcount live" aria-label={`${runningAgents} working`}>
                {runningAgents}
              </span>
            )}
          </NavLink>
          <NavLink to="/context" className={navClass}>
            <Icon name="book" />
            App Context
          </NavLink>
          <NavLink to="/huddle" className={navClass}>
            <Icon name="people" />
            Huddle · Decisions
            {openHuddleItems > 0 && (
              <span className="navcount" aria-label={`${openHuddleItems} open`}>
                {openHuddleItems}
              </span>
            )}
          </NavLink>
        </div>
      </nav>

      <div className="group">Recents</div>
      {recents.length === 0 && <div className="recent muted">No chats yet</div>}
      {recents.map((r) => (
        <NavLink key={r.id} to={`/chat/${r.id}`} className={({ isActive }) => `recent${isActive ? ' on' : ''}`}>
          {r.title}
        </NavLink>
      ))}

      <div className="grow" />

      {/* Sign in as: stands in for SSO in this preview. The server trusts the choice; see server/api.ts. */}
      <Dropdown.Root>
        <Dropdown.Trigger asChild>
          <button type="button" className="me mebtn">
            <span className="avatar">{me?.user.initials ?? '…'}</span>
            <span style={{ minWidth: 0, textAlign: 'left' }}>
              <span className="mename">{me?.user.name ?? (session.error ? 'Not signed in' : 'Loading…')}</span>
              <span className="muted" style={{ fontSize: 12, display: 'block' }}>
                {me?.app ? `${me.app.name} · ${roleOf(me.app.roles)}` : session.error ? session.error : ''}
              </span>
            </span>
            <span className="sr">. Sign in as someone else, or switch application</span>
            <Icon name="down" small />
          </button>
        </Dropdown.Trigger>
        <Dropdown.Portal>
          <Dropdown.Content className="menu-content wide-menu" sideOffset={6} align="start">
            {me && me.apps.length > 1 && (
              <>
                <Dropdown.Label className="menu-label">Application</Dropdown.Label>
                <Dropdown.RadioGroup value={me.app?.id ?? ''} onValueChange={(v) => void selectApp(v)}>
                  {me.apps.map((a) => (
                    <Dropdown.RadioItem key={a.id} value={a.id} className="menu-item">
                      <span>
                        {a.name}
                        <span className="menu-hint">{roleOf(a.roles)}</span>
                      </span>
                      <Dropdown.ItemIndicator className="menu-check">
                        <Icon name="check" small />
                      </Dropdown.ItemIndicator>
                    </Dropdown.RadioItem>
                  ))}
                </Dropdown.RadioGroup>
                <Dropdown.Separator className="menu-sep" />
              </>
            )}
            {me?.identity === 'proxy' ? (
              <Dropdown.Label className="menu-label">
                Signed in as {me.user.email} through your organisation's sign-in
              </Dropdown.Label>
            ) : (
              <>
                <Dropdown.Label className="menu-label">Sign in as · development only, the sign-in proxy replaces this</Dropdown.Label>
                <Dropdown.RadioGroup value={me?.user.id ?? ''} onValueChange={(v) => void signInAs(v)}>
                  {(me?.people ?? []).map((p) => (
                    <Dropdown.RadioItem key={p.id} value={p.id} className="menu-item">
                      <span>
                        {p.name}
                        <span className="menu-hint">{p.apps.map((a) => `${a.id} · ${ROLE_LABEL[a.role] ?? a.role}`).join(', ') || 'Member'}</span>
                      </span>
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
    </aside>
  );
}
