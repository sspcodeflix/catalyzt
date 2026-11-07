import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';

import { Sidebar } from './Sidebar';
import { TopBar } from './TopBar';

/**
 * Sidebar on the left, top bar and the routed page on the right. Below 900px the sidebar becomes
 * a modal drawer: the page behind it is inert while it is open, Escape closes it, and the sidebar
 * itself moves focus in and returns it.
 */
export function AppShell() {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const location = useLocation();
  const mainRef = useRef<HTMLElement>(null);

  // Close the drawer after navigating.
  useEffect(() => setDrawerOpen(false), [location.pathname]);

  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setDrawerOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drawerOpen]);

  // `inert` keeps the background out of the tab order and away from assistive technology. A layout
  // effect, so the attribute is gone before the sidebar's effect returns focus to the menu button.
  useLayoutEffect(() => {
    mainRef.current?.toggleAttribute('inert', drawerOpen);
  }, [drawerOpen]);

  return (
    <div className="shell">
      <Sidebar open={drawerOpen} onClose={() => setDrawerOpen(false)} />
      {drawerOpen && <div className="scrim" onClick={() => setDrawerOpen(false)} aria-hidden="true" />}
      <main ref={mainRef} className="main">
        <TopBar onOpenSidebar={() => setDrawerOpen(true)} />
        <Outlet />
      </main>
    </div>
  );
}
