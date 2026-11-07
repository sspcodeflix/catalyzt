/**
 * The simulation workspace (`.myworkspace/`): the applications, people, components and
 * backlogs Catalyzt seeds from. See SIMULATION_PLAN.md and .myworkspace/ASSIGNMENTS.md.
 *
 *   .myworkspace/personas.json         people, roles, apps
 *   .myworkspace/<APP>/team.json       the application, its workspaces, repos and components
 *   .myworkspace/<APP>/stories.json    the backlog (optional)
 *   .myworkspace/<APP>/manual-tests.csv  Octane-format manual tests (optional)
 *
 * Nothing here is placeholder data: with no workspace, Catalyzt starts empty.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export type WorkspaceRole = 'app_owner' | 'component_manager' | 'member';
const ROLES: WorkspaceRole[] = ['app_owner', 'component_manager', 'member'];

export interface WorkspacePerson {
  id: string;
  name: string;
  initials: string;
  email: string;
  app: string;
  role: WorkspaceRole;
}

export interface WorkspaceRepo {
  name: string;
  github: string;
  clone: boolean;
  languages: string[];
  testFrameworks: string[];
  note?: string;
}

export interface WorkspaceComponent {
  name: string;
  manager: string;
  workspace: string;
  repo: string;
  path: string;
  language: string;
  tests: string;
}

export interface WorkspaceStory {
  /** Optional; keys are assigned in order when missing. */
  key?: string;
  summary: string;
  description?: string;
  type?: 'Story' | 'Bug' | 'Task';
  status?: 'To Do' | 'In Progress' | 'Ready for UAT' | 'Done';
  fixVersion?: string;
  components?: string[];
  acceptanceCriteria: string[];
  requirements?: string[];
  /** Persona id. */
  assignee?: string;
  purpose?: 'uat' | 'regression';
  /** How long ago it was last updated, so the list looks lived-in. */
  updatedDaysAgo?: number;
}

export interface WorkspaceTeam {
  id: string;
  name: string;
  description: string;
  jiraProject: string;
  owner: string;
  workspaces: string[];
  repos: WorkspaceRepo[];
  components: WorkspaceComponent[];
  stories: WorkspaceStory[];
  /** Path of the Octane CSV, if present. */
  manualTestsCsv: string | null;
  dir: string;
}

export interface Workspace {
  root: string;
  people: WorkspacePerson[];
  teams: WorkspaceTeam[];
  /** Things that were wrong but not fatal. */
  warnings: string[];
}

export class WorkspaceError extends Error {}

const readJson = (path: string): unknown => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new WorkspaceError(`${path}: ${(e as Error).message}`);
  }
};

const str = (v: unknown, what: string): string => {
  if (typeof v !== 'string' || !v.trim()) throw new WorkspaceError(`${what} must be a non-empty string`);
  return v.trim();
};
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim()) : []);

/** Loads and validates the workspace. Returns null when the folder does not exist. */
export function loadWorkspace(root: string): Workspace | null {
  if (!existsSync(root) || !statSync(root).isDirectory()) return null;
  const warnings: string[] = [];

  const personasPath = join(root, 'personas.json');
  if (!existsSync(personasPath)) throw new WorkspaceError(`${personasPath} is missing`);
  const rawPeople = (readJson(personasPath) as { people?: unknown }).people;
  if (!Array.isArray(rawPeople)) throw new WorkspaceError('personas.json needs a "people" array');
  const people: WorkspacePerson[] = rawPeople.map((p, i) => {
    const r = (p ?? {}) as Record<string, unknown>;
    const role = str(r.role, `people[${i}].role`);
    if (!ROLES.includes(role as WorkspaceRole)) throw new WorkspaceError(`people[${i}].role "${role}" is not one of ${ROLES.join(', ')}`);
    return {
      id: str(r.id, `people[${i}].id`),
      name: str(r.name, `people[${i}].name`),
      initials: str(r.initials, `people[${i}].initials`).slice(0, 3),
      email: str(r.email, `people[${i}].email`),
      app: str(r.app, `people[${i}].app`),
      role: role as WorkspaceRole,
    };
  });
  const ids = new Set<string>();
  for (const p of people) {
    if (ids.has(p.id)) throw new WorkspaceError(`person id "${p.id}" appears twice`);
    ids.add(p.id);
  }

  const teams: WorkspaceTeam[] = [];
  for (const entry of readdirSync(root).sort()) {
    const dir = join(root, entry);
    const teamPath = join(dir, 'team.json');
    if (!statSync(dir).isDirectory() || !existsSync(teamPath)) continue;
    const t = readJson(teamPath) as Record<string, unknown>;
    const id = str(t.id, `${entry}/team.json id`);
    if (id !== entry) warnings.push(`${entry}/team.json has id "${id}"; the folder name is used for logs, the id for Catalyzt`);
    const owner = str(t.owner, `${id} owner`);
    if (!ids.has(owner)) throw new WorkspaceError(`${id}: owner "${owner}" is not in personas.json`);
    const repos: WorkspaceRepo[] = (Array.isArray(t.repos) ? t.repos : []).map((x, i) => {
      const r = (x ?? {}) as Record<string, unknown>;
      return {
        name: str(r.name, `${id} repos[${i}].name`),
        github: str(r.github, `${id} repos[${i}].github`),
        clone: r.clone !== false,
        languages: strs(r.languages),
        testFrameworks: strs(r.testFrameworks),
        note: typeof r.note === 'string' ? r.note : undefined,
      };
    });
    const repoNames = new Set(repos.map((r) => r.name));
    const workspaces = strs(t.workspaces);
    if (workspaces.length === 0) throw new WorkspaceError(`${id}: at least one workspace is needed`);
    const components: WorkspaceComponent[] = (Array.isArray(t.components) ? t.components : []).map((x, i) => {
      const c = (x ?? {}) as Record<string, unknown>;
      const comp: WorkspaceComponent = {
        name: str(c.name, `${id} components[${i}].name`),
        manager: str(c.manager, `${id} components[${i}].manager`),
        workspace: str(c.workspace, `${id} components[${i}].workspace`),
        repo: str(c.repo, `${id} components[${i}].repo`),
        path: typeof c.path === 'string' ? c.path : '.',
        language: typeof c.language === 'string' ? c.language : '',
        tests: typeof c.tests === 'string' ? c.tests : '',
      };
      if (!ids.has(comp.manager)) throw new WorkspaceError(`${id}: component "${comp.name}" has manager "${comp.manager}", who is not in personas.json`);
      if (!workspaces.includes(comp.workspace)) throw new WorkspaceError(`${id}: component "${comp.name}" is in workspace "${comp.workspace}", which the team does not list`);
      if (!repoNames.has(comp.repo)) throw new WorkspaceError(`${id}: component "${comp.name}" refers to repo "${comp.repo}", which the team does not list`);
      return comp;
    });
    for (const p of people.filter((x) => x.app === id && x.role === 'component_manager')) {
      if (!components.some((c) => c.manager === p.id)) warnings.push(`${id}: ${p.name} is a component manager with no components`);
    }

    const storiesPath = join(dir, 'stories.json');
    let stories: WorkspaceStory[] = [];
    if (existsSync(storiesPath)) {
      const raw = readJson(storiesPath);
      const list = Array.isArray(raw) ? raw : ((raw as { stories?: unknown })?.stories ?? []);
      if (!Array.isArray(list)) throw new WorkspaceError(`${storiesPath}: expected an array or {"stories": [...]}`);
      stories = list.map((x, i) => {
        const s = (x ?? {}) as Record<string, unknown>;
        const story: WorkspaceStory = {
          key: typeof s.key === 'string' ? s.key.trim() : undefined,
          summary: str(s.summary, `${id} stories[${i}].summary`),
          description: typeof s.description === 'string' ? s.description : '',
          type: s.type === 'Bug' || s.type === 'Task' ? s.type : 'Story',
          status: s.status === 'To Do' || s.status === 'In Progress' || s.status === 'Done' ? s.status : 'Ready for UAT',
          fixVersion: typeof s.fixVersion === 'string' ? s.fixVersion : '',
          components: strs(s.components),
          acceptanceCriteria: strs(s.acceptanceCriteria),
          requirements: strs(s.requirements),
          assignee: typeof s.assignee === 'string' ? s.assignee : undefined,
          purpose: s.purpose === 'uat' || s.purpose === 'regression' ? s.purpose : undefined,
          updatedDaysAgo: typeof s.updatedDaysAgo === 'number' ? s.updatedDaysAgo : undefined,
        };
        if (story.acceptanceCriteria.length === 0) warnings.push(`${id}: story "${story.summary}" has no acceptance criteria`);
        for (const c of story.components ?? []) if (!components.some((k) => k.name === c)) warnings.push(`${id}: story "${story.summary}" names unknown component "${c}"`);
        if (story.assignee && !ids.has(story.assignee)) warnings.push(`${id}: story "${story.summary}" is assigned to unknown person "${story.assignee}"`);
        return story;
      });
    }

    const csv = join(dir, 'manual-tests.csv');
    teams.push({
      id,
      name: str(t.name, `${id} name`),
      description: typeof t.description === 'string' ? t.description : '',
      jiraProject: str(t.jiraProject, `${id} jiraProject`),
      owner,
      workspaces,
      repos,
      components,
      stories,
      manualTestsCsv: existsSync(csv) ? csv : null,
      dir,
    });
  }
  if (teams.length === 0) throw new WorkspaceError(`${root} has no <APP>/team.json folders`);
  const teamIds = new Set(teams.map((t) => t.id));
  for (const p of people) if (!teamIds.has(p.app)) warnings.push(`${p.name} belongs to app "${p.app}", which has no team.json`);

  return { root, people, teams, warnings };
}
