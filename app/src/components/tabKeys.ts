import type { KeyboardEvent } from 'react';

/**
 * Arrow keys, Home and End for a hand-made role="tablist" (the ARIA tabs pattern): focus moves to the
 * next tab and selects it. Every tab stays in the Tab order as well, so nothing depends on this.
 */
export function onTabListKey(e: KeyboardEvent<HTMLElement>) {
  const tabs = [...e.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]')];
  const i = tabs.indexOf(document.activeElement as HTMLElement);
  if (i < 0) return;
  const n = tabs.length;
  const next = e.key === 'ArrowRight' ? (i + 1) % n : e.key === 'ArrowLeft' ? (i - 1 + n) % n : e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : -1;
  if (next < 0) return;
  e.preventDefault();
  tabs[next].focus();
  tabs[next].click();
}
