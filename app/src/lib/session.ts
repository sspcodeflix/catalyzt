/**
 * Who is using Catalyzt, and which application they are looking at.
 *
 * There is no sign-in in this preview. "Sign in as" picks a person from the workspace, and every
 * request carries the choice in the x-horizon-user and x-horizon-app headers (or _user and _app
 * query parameters for download links, which cannot send headers). Production replaces this with
 * SSO; the server-side resolution in server/api.ts is the only place that changes.
 */
import { useSyncExternalStore } from 'react';

export interface Person {
  id: string;
  name: string;
  initials: string;
  email: string;
}

export interface ComponentInfo {
  id: string;
  name: string;
  managerId: string | null;
  managerName: string | null;
  workspace: string | null;
  repo: string | null;
  path: string | null;
  language: string | null;
  tests: string | null;
}

export interface AppInfo {
  id: string;
  name: string;
  description: string;
  jiraProject: string;
  roles: ('member' | 'app_owner' | 'component_manager' | 'security_champion' | 'sre_lead' | 'product_owner' | 'uat_tester' | 'automation_engineer')[];
  workspaces: string[];
  components: ComponentInfo[];
}

export interface Me {
  user: Person;
  apps: AppInfo[];
  /** The application the session is looking at. */
  app: AppInfo | null;
  /** Everyone in the workspace, for the development "Sign in as" picker; empty behind a sign-in proxy. */
  people: (Person & { apps: { id: string; role: string }[] })[];
  /** dev: the browser picks the person; proxy: the sign-in proxy names them. */
  identity?: 'dev' | 'proxy';
}

interface SessionState {
  userId: string | null;
  appId: string | null;
  workspace: string | null;
  me: Me | null;
  loaded: boolean;
  error: string | null;
}

const KEY = 'hz-session';

function readSaved(): Pick<SessionState, 'userId' | 'appId' | 'workspace'> {
  try {
    const raw = localStorage.getItem(KEY);
    const v = raw ? (JSON.parse(raw) as Partial<SessionState>) : {};
    return { userId: v.userId ?? null, appId: v.appId ?? null, workspace: v.workspace ?? null };
  } catch {
    return { userId: null, appId: null, workspace: null };
  }
}

let state: SessionState = { ...readSaved(), me: null, loaded: false, error: null };
/**
 * Counts changes of who or which application. Every store captures it before a request and
 * ignores the response when it moved on, so a slow answer for the old scope can never land in
 * the new one.
 */
let epoch = 0;
export const sessionEpoch = () => epoch;
/** Thrown by stores when a response arrives for a person or application that is no longer selected. */
export class StaleScopeError extends Error {
  constructor() {
    super('The application changed while this request was running.');
  }
}
/** "<user>/<application>": the key everything cached in the browser belongs to. */
export const scopeKey = () => `${state.userId ?? ''}/${state.appId ?? ''}`;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify({ userId: state.userId, appId: state.appId, workspace: state.workspace }));
  } catch {
    /* storage unavailable: the choice lasts for this visit */
  }
}

/** Headers every API request carries. */
export function sessionHeaders(): Record<string, string> {
  const h: Record<string, string> = {};
  if (state.userId) h['x-horizon-user'] = state.userId;
  if (state.appId) h['x-horizon-app'] = state.appId;
  return h;
}

/** For links the browser follows directly (downloads), which cannot carry headers. */
export function withSession(url: string): string {
  const u = new URL(url, window.location.origin);
  if (state.userId) u.searchParams.set('_user', state.userId);
  if (state.appId) u.searchParams.set('_app', state.appId);
  return u.pathname + u.search;
}

/** fetch with the session headers. Use this for every /api call. */
export function http(input: string, init: RequestInit = {}): Promise<Response> {
  return fetch(input, { ...init, headers: { ...sessionHeaders(), ...(init.headers as Record<string, string> | undefined) } });
}

let loading: Promise<void> | null = null;

/** Loads who the user is and which apps they belong to; picks a default app when none is chosen. */
export function loadSession(force = false): Promise<void> {
  if (loading && !force) return loading;
  const mine = epoch;
  loading = (async () => {
    try {
      let res = await http('/api/me');
      // A newer sign-in or application choice started while this one was in flight: it wins.
      if (mine !== epoch) return;
      if (!res.ok && (res.status === 404 || res.status === 403) && state.appId) {
        // The remembered application is gone or no longer this person's (the workspace changed):
        // forget it and let the server pick their first application, instead of a dead "Not signed in".
        state = { ...state, appId: null, workspace: null };
        save();
        res = await http('/api/me');
        if (mine !== epoch) return;
      }
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `Request failed (${res.status})`);
      const me = (await res.json()) as Me;
      if (mine !== epoch) return;
      const appId = me.app?.id ?? null;
      const workspace = appId === state.appId && state.workspace ? state.workspace : (me.app?.workspaces[0] ?? null);
      // The server may have resolved a different person or application than the saved one (for example
      // after the workspace changed); that counts as a scope change for every store.
      if (me.user.id !== state.userId || appId !== state.appId) epoch++;
      state = { ...state, userId: me.user.id, appId, workspace, me, loaded: true, error: null };
      save();
    } catch (e) {
      if (mine !== epoch) return;
      state = { ...state, loaded: true, error: (e as Error).message };
    }
    emit();
    window.dispatchEvent(new Event('hz:session'));
  })();
  return loading;
}

export function signInAs(userId: string) {
  epoch++;
  state = { ...state, userId, appId: null, workspace: null, me: null, loaded: false };
  save();
  emit();
  return loadSession(true);
}

export function selectApp(appId: string) {
  if (appId === state.appId) return Promise.resolve();
  epoch++;
  state = { ...state, appId, workspace: null };
  save();
  emit();
  return loadSession(true);
}

export function selectWorkspace(workspace: string) {
  state = { ...state, workspace };
  save();
  emit();
}

/** The composer's scope for the application and workspace the session is looking at. */
export function currentScope(): { appName: string; appId: string; workspace: string } | null {
  const app = state.me?.app;
  if (!app) return null;
  return { appName: app.name, appId: app.id, workspace: state.workspace ?? app.workspaces[0] ?? '' };
}

export const useSession = () => useSyncExternalStore(subscribe, () => state);
export const getSession = () => state;

export const isOwner = (s: SessionState = state) => s.me?.app?.roles.includes('app_owner') ?? false;
export const isManager = (s: SessionState = state) => s.me?.app?.roles.includes('component_manager') ?? false;

if (typeof window !== 'undefined') void loadSession();
