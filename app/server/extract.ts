/**
 * Content extraction for App Context: turns the files read from a clone (or an upload) into clean,
 * classified passages before they are indexed.
 *
 *   clean       HTML comments, logo/badge/image-only lines, raw HTML wrappers, front matter and
 *               licence headers are removed; tables, lists and code stay as written.
 *   sections    Markdown and reStructuredText are split by heading; every passage carries its
 *               heading (and the parent headings when it is nested), so "README › Architecture" text
 *               reads, matches and embeds as what it is.
 *   kinds       overview (the opening of a root README and its overview-like sections, plus the
 *               repository card), guide (other documentation), api (protos, OpenAPI), build, ci,
 *               history (changelogs, release notes: capped, newest first), requirement (Jira).
 *   summaries   build and CI files get one plain-language summary passage (services and ports,
 *               modules, scripts, jobs, base images) ahead of a few raw passages kept for exact lookups.
 *   dedup       the same text appearing twice in a source is kept once.
 *
 * Locators stay "<path> ¶<n>" (per file), so exclusions and citations keep working.
 */
import { createHash } from 'node:crypto';

export type PassageKind = 'overview' | 'guide' | 'api' | 'build' | 'ci' | 'history' | 'requirement';

export interface ExtractDoc {
  /** Relative path, used in locators. */
  path: string;
  text: string;
  /** A build, container or CI file (R19). */
  build?: boolean;
}

export interface Passage {
  locator: string;
  text: string;
  kind: PassageKind;
}

const MIN_CHARS = 40;
const TARGET_CHARS = 900;
const MAX_CHARS = 2000;
/** History files keep their newest entries only; older ones add nothing an answer needs. */
const MAX_HISTORY_PASSAGES = 25;
/** Raw passages kept per build or CI file next to its summary. */
const MAX_RAW_BUILD_PASSAGES = 4;
/** The order passages are kept in when a source reaches its cap: what answers need most comes first. */
export const KIND_ORDER: PassageKind[] = ['overview', 'guide', 'api', 'requirement', 'build', 'ci', 'history'];

const base = (p: string) => p.split('/').pop() ?? p;
const isRootReadme = (p: string) => /^readme(\.[a-z]+)?$/i.test(p);
const HISTORY_NAME = /^(changelog|changes|history|news|releases?|release[-_ ]?notes)(\.[a-z]+)?$/i;
const CI_NAME = /(^|\/)(\.travis\.yml|\.gitlab-ci\.yml|Jenkinsfile)$|^\.github\/workflows\//i;
const API_NAME = /\.proto$|(openapi|swagger)[^/]*\.(ya?ml|json)$/i;
const OVERVIEW_HEADING = /\b(overview|about|introduction|intro|what is|architecture|features|description|summary|purpose|how it works)\b/i;

/** Normalises whitespace inside lines, keeping line breaks and leading indentation (R20). */
function tidy(text: string): string {
  return text
    .split('\n')
    .map((l) => l.replace(/\s+$/, '').replace(/(\S)[^\S\n]+/g, '$1 '))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const cap = (t: string) => (t.length > MAX_CHARS ? `${t.slice(0, MAX_CHARS - 3)}…` : t);

/* ---------- Cleaning ---------- */

const IMAGE = /!\[[^\]]*\]\([^)]*\)/g;
const LINKED_IMAGE = /\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)/g;

/** Removes what is markup rather than content: comments, front matter, logos and badges, empty HTML wrappers. */
export function cleanMarkdown(text: string): { text: string; title: string | null } {
  let t = text.replace(/\r\n?/g, '\n');
  let title: string | null = null;
  // Front matter (Jekyll docs): its title is kept as the document's title.
  const fm = /^---\n([\s\S]*?)\n---\n/.exec(t);
  if (fm) {
    title = /^title:\s*["']?(.+?)["']?\s*$/m.exec(fm[1])?.[1] ?? null;
    t = t.slice(fm[0].length);
  }
  t = t.replace(/<!--[\s\S]*?-->/g, '');
  const out: string[] = [];
  let fence = false;
  for (const line of t.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    if (fence || /^\s*(```|~~~)/.test(line)) {
      out.push(line);
      continue;
    }
    // A line of only images or badges (with or without links around them) says nothing.
    const stripped = line.replace(LINKED_IMAGE, '').replace(IMAGE, '').replace(/<img\b[^>]*>/gi, '');
    if (line.trim() && !stripped.replace(/<\/?[a-z][^>]*>/gi, '').replace(/[\s|·•-]/g, '')) continue;
    // Raw HTML wrappers (<p align="center">, </div>) around content: keep the content, drop the tags.
    out.push(/^\s*<\/?(p|div|span|center|br|picture|source|h\d|a)\b[^>]*>\s*$/i.test(line) ? '' : line.replace(/<\/?(p|div|span|center|br|sup|sub)\b[^>]*>/gi, ''));
  }
  return { text: out.join('\n'), title };
}

/** Drops a leading comment block that is a licence or copyright notice (build files, protos). */
export function stripLicenceHeader(text: string): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  let i = 0;
  const comment = /^\s*(#|\/\/|\/\*|\*|<!--|-->|\*\/)/;
  while (i < lines.length && (comment.test(lines[i]) || !lines[i].trim())) i++;
  const head = lines.slice(0, i).join('\n');
  return /copyright|licen[cs]e/i.test(head) ? lines.slice(i).join('\n') : text;
}

/* ---------- Sections ---------- */

interface Section {
  /** Heading path from the top of the document, e.g. ["Online Boutique", "Architecture"]. */
  path: string[];
  level: number;
  /** The heading line as written, when the section has one. */
  heading: string | null;
  body: string[];
}

/** Splits Markdown (ATX and setext headings) and reStructuredText (underlined titles) into sections, outside code fences. */
export function splitSections(text: string): Section[] {
  const lines = text.split('\n');
  const sections: Section[] = [{ path: [], level: 0, heading: null, body: [] }];
  const stack: { level: number; title: string }[] = [];
  const start = (level: number, title: string, heading: string) => {
    while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
    stack.push({ level, title });
    sections.push({ path: stack.map((s) => s.title), level, heading, body: [] });
  };
  let fence = false;
  const rstLevels: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const cur = sections[sections.length - 1];
    if (!fence) {
      const atx = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
      if (atx) {
        start(atx[1].length, atx[2].replace(/[*_`]/g, '').trim(), line.trim());
        continue;
      }
      const next = lines[i + 1] ?? '';
      // Setext (Title / ====) and reST (Title / ----, ~~~~, ^^^^) underlines.
      const under = /^([=\-~^"'`#*+])\1{2,}\s*$/.exec(next);
      if (line.trim() && !/^\s*[-*+|>]/.test(line) && under && next.trim().length >= Math.min(line.trim().length, 3) && !cur.body.at(-1)?.trim()) {
        const ch = under[1];
        if (!rstLevels.includes(ch)) rstLevels.push(ch);
        const level = ch === '=' ? 1 : ch === '-' ? 2 : Math.min(6, rstLevels.indexOf(ch) + 1);
        start(level, line.trim().replace(/[*_`]/g, ''), `${'#'.repeat(level)} ${line.trim()}`);
        i++;
        continue;
      }
    }
    cur.body.push(line);
  }
  return sections;
}

/** Blocks of a section body: paragraphs separated by blank lines, a code fence always one block. */
function blocks(body: string[]): string[] {
  const out: string[] = [];
  let buf: string[] = [];
  let fence = false;
  const flush = () => {
    const b = buf.join('\n').trim();
    if (b) out.push(b);
    buf = [];
  };
  for (const line of body) {
    if (/^\s*(```|~~~)/.test(line)) {
      if (!fence) flush();
      buf.push(line);
      fence = !fence;
      if (!fence) flush();
      continue;
    }
    if (!fence && !line.trim()) {
      flush();
      continue;
    }
    buf.push(line);
  }
  flush();
  return out;
}

/** A table-of-contents section (only links in a list) is navigation, not content. */
const isToc = (sec: Section, text: string) =>
  /\b(table of contents|contents|toc)\b/i.test(sec.path.at(-1) ?? '') || (text.split('\n').filter((l) => l.trim()).length > 2 && text.split('\n').every((l) => !l.trim() || /^\s*[-*+]\s*\[[^\]]+\]\(#[^)]*\)\s*$/.test(l) || /^\s*\d+\.\s*\[[^\]]+\]\(#[^)]*\)\s*$/.test(l)));

/** The heading line a passage starts with: as written at the top level, with its parents when nested. */
function headingLine(sec: Section, continued: boolean): string | null {
  if (!sec.heading) return null;
  const hashes = '#'.repeat(Math.max(1, Math.min(sec.level, 6)));
  const title = sec.path.length > 1 ? `${hashes} ${sec.path.join(' › ')}` : sec.heading;
  return continued ? `${title} (continued)` : title;
}

function kindForDoc(path: string, sec: Section, sectionIndex: number): PassageKind {
  const name = base(path);
  if (HISTORY_NAME.test(name)) return 'history';
  if (API_NAME.test(path)) return 'api';
  if (isRootReadme(path)) {
    // The opening of the root README (before or under its title) and overview-like sections describe the repository.
    if (sectionIndex <= 1 || (sec.level <= 2 && sec.path.slice(-1).some((h) => OVERVIEW_HEADING.test(h)))) return 'overview';
  }
  return 'guide';
}

/** A documentation file as passages: cleaned, by section, with headings, sized to about 900 characters. */
export function documentPassages(path: string, text: string, kindOverride?: PassageKind): Passage[] {
  const { text: clean, title } = /\.(md|markdown|rst|txt)$/i.test(path) || !/\.[a-z0-9]+$/i.test(base(path)) ? cleanMarkdown(text) : { text: stripLicenceHeader(text), title: null };
  const sections = splitSections(clean);
  if (title && !sections.some((s) => s.heading)) sections[0].heading = `# ${title}`, (sections[0].path = [title]), (sections[0].level = 1);
  const out: Passage[] = [];
  let n = 0;
  const push = (text: string, kind: PassageKind) => {
    const t = tidy(text);
    if (t.length < MIN_CHARS) return;
    n++;
    out.push({ locator: `${path} ¶${n}`, text: cap(t), kind });
  };
  sections.forEach((sec, si) => {
    const parts = blocks(sec.body);
    if (!parts.length) return;
    const joined = parts.join('\n\n');
    if (isToc(sec, joined)) return;
    const kind = kindOverride ?? kindForDoc(path, sec, si);
    let buf = '';
    let first = true;
    const flush = () => {
      if (!buf.trim()) return;
      const h = headingLine(sec, !first);
      push(h ? `${h}\n${buf}` : buf, kind);
      buf = '';
      first = false;
    };
    for (const b of parts) {
      // One block longer than the cap is split by lines.
      const pieces = b.length > MAX_CHARS ? splitLong(b) : [b];
      for (const p of pieces) {
        if (buf && buf.length + p.length > TARGET_CHARS) flush();
        buf = buf ? `${buf}\n\n${p}` : p;
        if (buf.length >= TARGET_CHARS) flush();
      }
    }
    flush();
  });
  return mergeSmall(out);
}

function splitLong(b: string): string[] {
  const out: string[] = [];
  let buf: string[] = [];
  let len = 0;
  for (const line of b.split('\n')) {
    if (len && len + line.length > TARGET_CHARS) {
      out.push(buf.join('\n'));
      buf = [];
      len = 0;
    }
    buf.push(line);
    len += line.length + 1;
  }
  if (buf.length) out.push(buf.join('\n'));
  return out;
}

/** Neighbouring small passages of the same file and kind are joined (each keeps its heading line), so short sections are not lost. */
function mergeSmall(ps: Passage[]): Passage[] {
  const out: Passage[] = [];
  for (const p of ps) {
    const prev = out.at(-1);
    if (prev && prev.kind === p.kind && prev.text.length < 300 && p.text.length < 300 && prev.text.length + p.text.length <= TARGET_CHARS && prev.locator.split(' ¶')[0] === p.locator.split(' ¶')[0]) {
      prev.text = `${prev.text}\n\n${p.text}`;
      continue;
    }
    out.push({ ...p });
  }
  // Renumber within each file after merging.
  const seen = new Map<string, number>();
  return out.map((p) => {
    const file = p.locator.split(' ¶')[0];
    const k = (seen.get(file) ?? 0) + 1;
    seen.set(file, k);
    return { ...p, locator: `${file} ¶${k}` };
  });
}

/* ---------- Build and CI summaries ---------- */

const uniq = <T,>(xs: T[]) => [...new Set(xs)];
const listOf = (xs: string[], max = 12) => (xs.length > max ? `${xs.slice(0, max).join(', ')} and ${xs.length - max} more` : xs.join(', '));

function composeSummary(text: string): string[] {
  const lines = text.split('\n');
  const services: { name: string; image?: string; build?: boolean; ports: string[]; depends: string[] }[] = [];
  let inServices = false;
  let cur: (typeof services)[number] | null = null;
  let key = '';
  for (const raw of lines) {
    if (/^services:\s*$/.test(raw)) {
      inServices = true;
      continue;
    }
    if (/^\S/.test(raw) && !/^services:/.test(raw)) inServices = false;
    if (!inServices) continue;
    const svc = /^ {2}([A-Za-z0-9_.-]+):\s*$/.exec(raw);
    if (svc) {
      cur = { name: svc[1], ports: [], depends: [] };
      services.push(cur);
      key = '';
      continue;
    }
    if (!cur) continue;
    const kv = /^ {4}([a-z_]+):\s*(.*)$/.exec(raw);
    if (kv) {
      key = kv[1];
      if (key === 'image') cur.image = kv[2].replace(/["']/g, '');
      if (key === 'build') cur.build = true;
      if (key === 'ports' && kv[2].startsWith('[')) cur.ports.push(...kv[2].replace(/[[\]"' ]/g, '').split(',').filter(Boolean));
      if (key === 'depends_on' && kv[2].startsWith('[')) cur.depends.push(...kv[2].replace(/[[\]"' ]/g, '').split(',').filter(Boolean));
      continue;
    }
    const item = /^ {6}-\s*["']?([^"'#]+?)["']?\s*$/.exec(raw);
    if (item && key === 'ports') cur.ports.push(item[1]);
    else if (item && key === 'depends_on') cur.depends.push(item[1].replace(/:$/, ''));
    else if (key === 'depends_on' && /^ {6}([A-Za-z0-9_.-]+):\s*$/.test(raw)) cur.depends.push(/^ {6}([A-Za-z0-9_.-]+):/.exec(raw)![1]);
  }
  if (!services.length) return [];
  return [
    `Defines ${services.length} service${services.length === 1 ? '' : 's'}:`,
    ...services.map((s) => `- ${s.name}${s.image ? ` (image ${s.image})` : s.build ? ' (built from source)' : ''}${s.ports.length ? `, ports ${s.ports.join(', ')}` : ''}${s.depends.length ? `, depends on ${s.depends.join(', ')}` : ''}`),
  ];
}

function packageSummary(text: string): string[] {
  try {
    const j = JSON.parse(text) as { name?: string; description?: string; scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string>; workspaces?: unknown };
    const deps = Object.keys(j.dependencies ?? {});
    const dev = Object.keys(j.devDependencies ?? {});
    const scripts = j.scripts ?? {};
    return [
      `Package ${j.name ?? '(unnamed)'}${j.description ? `: ${j.description}` : ''}.`,
      Object.keys(scripts).length ? `Scripts: ${listOf(Object.keys(scripts), 20)}.` : '',
      scripts.test ? `Tests run with: ${scripts.test}` : '',
      deps.length ? `${deps.length} dependencies, including ${listOf(deps, 15)}.` : '',
      dev.length ? `${dev.length} development dependencies, including ${listOf(dev, 10)}.` : '',
    ].filter(Boolean);
  } catch {
    return [];
  }
}

const tag = (xml: string, name: string) => new RegExp(`<${name}>\\s*([^<]+?)\\s*</${name}>`).exec(xml)?.[1] ?? null;

function pomSummary(text: string): string[] {
  const noParent = text.replace(/<parent>[\s\S]*?<\/parent>/, '');
  const head = noParent.split(/<dependencies>|<build>/)[0];
  const parent = /<parent>([\s\S]*?)<\/parent>/.exec(text)?.[1] ?? '';
  const modules = [...text.matchAll(/<module>\s*([^<]+?)\s*<\/module>/g)].map((m) => m[1]);
  const deps = uniq([...(/<dependencies>([\s\S]*?)<\/dependencies>/.exec(text)?.[1] ?? '').matchAll(/<artifactId>\s*([^<]+?)\s*<\/artifactId>/g)].map((m) => m[1]));
  const java = tag(text, 'java.version') ?? tag(text, 'maven.compiler.source') ?? tag(text, 'maven.compiler.release');
  return [
    `Maven project ${tag(head, 'artifactId') ?? '(unknown)'}${tag(head, 'name') ? ` (${tag(head, 'name')})` : ''}${tag(head, 'packaging') ? `, packaging ${tag(head, 'packaging')}` : ''}.`,
    tag(head, 'description') ? `Description: ${tag(head, 'description')}` : '',
    parent ? `Parent: ${tag(parent, 'artifactId')} ${tag(parent, 'version') ?? ''}`.trim() + '.' : '',
    java ? `Java version ${java}.` : '',
    modules.length ? `Modules: ${listOf(modules, 20)}.` : '',
    deps.length ? `Dependencies: ${listOf(deps, 20)}.` : '',
  ].filter(Boolean);
}

function dockerfileSummary(text: string): string[] {
  const get = (re: RegExp) => [...text.matchAll(re)].map((m) => m[1].trim());
  const from = get(/^\s*FROM\s+(.+)$/gim);
  const expose = get(/^\s*EXPOSE\s+(.+)$/gim);
  const cmd = get(/^\s*(?:ENTRYPOINT|CMD)\s+(.+)$/gim);
  return [from.length ? `Base image${from.length > 1 ? 's (multi-stage)' : ''}: ${from.join(', ')}.` : '', expose.length ? `Exposes ${expose.join(', ')}.` : '', cmd.length ? `Starts with ${cmd.at(-1)}.` : ''].filter(Boolean);
}

function workflowSummary(text: string): string[] {
  const name = /^name:\s*(.+)$/m.exec(text)?.[1]?.replace(/["']/g, '');
  const onBlock = /^on:[ \t]*(.*)$/m.exec(text);
  let triggers: string[] = [];
  if (onBlock) {
    if (onBlock[1].trim()) triggers = onBlock[1].replace(/[[\]]/g, '').split(',').map((s) => s.trim()).filter(Boolean);
    else {
      const after = text.slice(onBlock.index + onBlock[0].length).split('\n');
      for (const l of after) {
        if (/^\S/.test(l)) break;
        const m = /^ {2}([a-z_]+):/.exec(l);
        if (m) triggers.push(m[1]);
      }
    }
  }
  const jobsAt = text.search(/^jobs:\s*$/m);
  const jobs: string[] = [];
  if (jobsAt >= 0) for (const l of text.slice(jobsAt).split('\n').slice(1)) {
    if (/^\S/.test(l)) break;
    const m = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(l);
    if (m) jobs.push(m[1]);
  }
  const runs = uniq([...text.matchAll(/^\s*(?:-\s*)?run:\s*(.+)$/gm)].map((m) => m[1].trim()).filter((r) => r !== '|' && r !== '>'));
  const uses = uniq([...text.matchAll(/uses:\s*([^\s@#]+)/g)].map((m) => m[1]));
  return [
    `CI workflow${name ? ` "${name}"` : ''}${triggers.length ? `, triggered on ${triggers.join(', ')}` : ''}.`,
    jobs.length ? `Jobs: ${jobs.join(', ')}.` : '',
    runs.length ? `Commands: ${listOf(runs, 8)}.` : '',
    uses.length ? `Actions used: ${listOf(uses, 10)}.` : '',
  ].filter(Boolean);
}

function makefileSummary(text: string): string[] {
  const targets = uniq([...text.matchAll(/^([A-Za-z0-9_.-]+):(?!=)/gm)].map((m) => m[1]).filter((t) => !t.startsWith('.')));
  return targets.length ? [`Make targets: ${listOf(targets, 20)}.`] : [];
}

function gradleSummary(text: string): string[] {
  const plugins = uniq([...text.matchAll(/id\s*\(?\s*['"]([^'"]+)['"]/g)].map((m) => m[1]));
  const deps = uniq([...text.matchAll(/(?:implementation|api|testImplementation|compile|runtimeOnly)\s*\(?\s*['"]([^'"]+)['"]/g)].map((m) => m[1].split(':').slice(0, 2).join(':')));
  return [plugins.length ? `Gradle plugins: ${listOf(plugins)}.` : '', deps.length ? `Dependencies: ${listOf(deps, 20)}.` : ''].filter(Boolean);
}

/** One plain-language summary of a build or CI file, or null when nothing useful can be said. */
export function buildSummary(path: string, text: string): string | null {
  const name = base(path);
  let lines: string[] = [];
  if (/docker-compose|^compose\./i.test(name)) lines = composeSummary(text);
  else if (name === 'package.json') lines = packageSummary(text);
  else if (name === 'pom.xml') lines = pomSummary(text);
  else if (/^Dockerfile/.test(name)) lines = dockerfileSummary(text);
  else if (/^\.github\/workflows\//.test(path) || name === '.gitlab-ci.yml') lines = workflowSummary(text);
  else if (/makefile$/i.test(name)) lines = makefileSummary(text);
  else if (/\.gradle(\.kts)?$/.test(name)) lines = gradleSummary(text);
  if (!lines.length) return null;
  return `### ${path} (summary)\n${lines.join('\n')}`;
}

/** A build or CI file: its summary first, then a few raw passages kept as written for exact lookups. */
export function buildPassages(path: string, text: string): Passage[] {
  const kind: PassageKind = CI_NAME.test(path) ? 'ci' : 'build';
  const body = stripLicenceHeader(text);
  const out: Passage[] = [];
  const summary = buildSummary(path, body);
  if (summary) out.push({ locator: `${path} · summary`, text: cap(summary), kind });
  let buf: string[] = [];
  let len = 0;
  let n = 0;
  const flush = () => {
    const t = buf.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    buf = [];
    len = 0;
    if (t.length < MIN_CHARS || n >= MAX_RAW_BUILD_PASSAGES) return;
    n++;
    out.push({ locator: `${path} ¶${n}`, text: cap(t), kind });
  };
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    if (len && len + line.length > TARGET_CHARS) flush();
    buf.push(line);
    len += line.length + 1;
  }
  flush();
  return out;
}

/* ---------- Whole source ---------- */

const norm = (t: string) => createHash('sha1').update(t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()).digest('hex');

/**
 * Every passage of a source: documentation by section, build and CI files summarised, history capped,
 * duplicates dropped, then ordered by kind (overview first, history last) and capped in total.
 */
export function extractPassages(docs: ExtractDoc[], max = 400, extra: Passage[] = []): Passage[] {
  const all: Passage[] = [...extra];
  for (const d of docs) {
    if (d.build) all.push(...buildPassages(d.path, d.text));
    else {
      const ps = documentPassages(d.path, d.text);
      all.push(...(ps[0]?.kind === 'history' ? ps.slice(0, MAX_HISTORY_PASSAGES) : ps));
    }
  }
  const seen = new Set<string>();
  const unique = all.filter((p) => {
    const body = p.text.replace(/^#{1,6} .*\n/, '');
    const h = norm(body);
    if (seen.has(h)) return false;
    seen.add(h);
    return true;
  });
  const order = (k: PassageKind) => KIND_ORDER.indexOf(k);
  // Stable: within a kind, the files keep the order they were read in.
  return unique
    .map((p, i) => ({ p, i }))
    .sort((a, b) => order(a.p.kind) - order(b.p.kind) || a.i - b.i)
    .slice(0, max)
    .map((x) => x.p);
}

/* ---------- The repository card ---------- */

export interface RepoFacts {
  name: string;
  github: string;
  description?: string | null;
  note?: string | null;
  languages: string[];
  testFrameworks: string[];
  /** Components of the application built from this repository, with their path and manager. */
  components: { name: string; path: string | null; manager: string | null }[];
}

/**
 * One overview passage per repository: what it is (team description, the README's opening),
 * what it is built with, and which components of the application live in it. It answers "what is
 * this repository about" directly, whatever words the question uses.
 */
export function repositoryCard(facts: RepoFacts, docs: ExtractDoc[]): Passage {
  const readme = docs.find((d) => !d.build && isRootReadme(d.path));
  let intro = '';
  if (readme) {
    const opening = documentPassages(readme.path, readme.text).filter((p) => p.kind === 'overview').slice(0, 2);
    intro = opening
      .map((p) => p.text.replace(/^#{1,6} .*\n/, '').replace(/```[\s\S]*?```/g, '').trim())
      .filter(Boolean)
      .join('\n\n')
      .slice(0, 1100);
  }
  const lines = [
    `# Repository ${facts.name} (overview)`,
    `GitHub: ${facts.github}.${facts.description ? ` ${facts.description}` : ''}`,
    facts.languages.length ? `Languages: ${facts.languages.join(', ')}.` : '',
    facts.testFrameworks.length ? `Tests: ${facts.testFrameworks.join(', ')}.` : '',
    facts.components.length ? `Components of this application in it: ${facts.components.map((c) => `${c.name}${c.path ? ` (${c.path})` : ''}${c.manager ? `, managed by ${c.manager}` : ''}`).join('; ')}.` : '',
    facts.note ? `Note: ${facts.note}` : '',
    intro ? `\nFrom the README:\n${intro}` : '',
  ].filter(Boolean);
  return { locator: 'Overview', text: cap(lines.join('\n')), kind: 'overview' };
}

/* ---------- Question intent ---------- */

/** "What is this repo about", "give me an overview", "what does X do": questions the overview passages answer. */
export const OVERVIEW_QUESTION = new RegExp(
  [
    String.raw`\bwhat\s+(is|are)\s+(this|the|that|these|our)\s+(repo|repos|repository|repositories|project|app|application|service|services|system|codebase|component)s?\b(?!\s+\w+\s+(for|of)\b)`,
    String.raw`\bwhat('s|\s+is|\s+are)\b.{0,50}\babout\s*\??\s*$`,
    String.raw`\bwhat\s+does\s+(\S+\s+){1,3}do\b`,
    String.raw`\b(overview|summari[sz]e|high[- ]level|introduction to|tell me about|describe (this|the) (repo|repository|project|app|application|system|codebase)|purpose of (this|the))\b`,
  ].join('|'),
  'i',
);
/** Questions where build and CI files are the right source. */
export const BUILD_QUESTION = /\b(build|builds|compile|maven|gradle|npm|yarn|pnpm|docker|dockerfile|compose|container|image|port|ports|ci|pipeline|workflow|github actions|travis|jenkins|release|deploy|deployment|dependenc(y|ies)|version|script|scripts|makefile|make target|run (the )?tests?|test command|kubernetes|helm|env(ironment)? var)/i;
/** Questions where the history (changelog) is the right source. */
export const HISTORY_QUESTION = /\b(changelog|change log|release notes?|what changed|changes in|since version|in version|history|added in|fixed in|new in)\b/i;

/**
 * How much a passage of each kind counts for a question, as a multiplier on its relevance: build,
 * CI and history passages give way to documentation unless the question is about them; overview
 * passages are preferred for overview questions.
 */
export function kindPrior(kind: string | null | undefined, question: string): number {
  if (!kind) return 1;
  if (kind === 'overview') return OVERVIEW_QUESTION.test(question) ? 1.35 : 1;
  if (kind === 'build' || kind === 'ci') return BUILD_QUESTION.test(question) ? 1.1 : 0.6;
  if (kind === 'history') return HISTORY_QUESTION.test(question) ? 1.1 : 0.5;
  return 1;
}
