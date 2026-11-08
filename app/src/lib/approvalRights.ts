/**
 * Who may decide a proposed change, as the browser can tell it (F19, mirrored from the server): an app
 * owner decides anything; a component manager decides only changes whose components they all manage;
 * a change that names no component is the owner's. The server is still the authority; this only keeps
 * the card from offering a button that will be refused.
 */
import type { AppInfo } from './session';

export function approvalBlockReason(app: AppInfo | null | undefined, userId: string | null, components: string[] | null): string | null {
  if (!app || !userId) return null;
  if (app.roles.includes('app_owner')) return null;
  if (!app.roles.includes('component_manager')) return 'Only an app owner or the manager of the components this change touches can decide it.';
  // Unknown components (the story is not loaded in this session): let the server decide.
  if (components === null) return null;
  if (components.length === 0) return 'This change names no component, so only an app owner can decide it.';
  const foreign = components.filter((name) => app.components.find((c) => c.name === name)?.managerId !== userId);
  if (foreign.length === 0) return null;
  const managers = [...new Set(foreign.map((name) => app.components.find((c) => c.name === name)?.managerName).filter(Boolean))];
  return `Only the manager of ${foreign.join(', ')}${managers.length ? ` (${managers.join(', ')})` : ''} or an app owner can decide this change.`;
}
