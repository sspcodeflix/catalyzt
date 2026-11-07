import { NavLink } from 'react-router-dom';

import { currentUser, recents } from '../lib/data';
import { useAgentActivity } from '../lib/agentsStore';
import { useHuddle } from '../lib/huddleData';
import { useTickets } from '../lib/ticketStore';
import { HorizonMark } from './HorizonMark';
import { Icon } from './Icon';

interface SidebarProps {
  open: boolean;
  onClose: () => void;
}

const navClass = ({ isActive }: { isActive: boolean }) => (isActive ? 'on' : undefined);

export function Sidebar({ open, onClose }: SidebarProps) {
  const runningAgents = useAgentActivity().agents.filter((a) => a.status === 'running' && a.parentId).length;
  const openHuddleItems = useHuddle().filter((i) => !i.decision).length;
  const waiting = useTickets().filter((t) => t.uat.state === 'not-analysed').length;
  return (
    <aside className={`sidebar${open ? ' open' : ''}`} aria-label="Horizon">
      <div className="brandrow">
        <span className="brand">
          <HorizonMark size={28} />
          <b>Horizon</b>
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
            Hexa
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
            Huddle
            {openHuddleItems > 0 && (
              <span className="navcount" aria-label={`${openHuddleItems} open`}>
                {openHuddleItems}
              </span>
            )}
          </NavLink>
        </div>
      </nav>

      <div className="group">Recents</div>
      {recents.map((r) => (
        <NavLink key={r.id} to={`/chat/${r.id}`} className={({ isActive }) => `recent${isActive ? ' on' : ''}`}>
          {r.title}
        </NavLink>
      ))}

      <div className="grow" />
      <div className="me">
        <span className="avatar">{currentUser.initials}</span>
        <div style={{ minWidth: 0 }}>
          <div>{currentUser.name}</div>
          <div className="muted" style={{ fontSize: 12 }}>
            {currentUser.team}
          </div>
        </div>
      </div>
    </aside>
  );
}
