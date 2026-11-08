import * as Dropdown from '@radix-ui/react-dropdown-menu';
import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';

import { uploadAttachment } from '../lib/attachments';
import { agentLabel, capabilities, scopeLabel } from '../lib/data';
import { useSession } from '../lib/session';
import { detectTestType, testTypeLabel } from '../lib/testType';
import { useTickets } from '../lib/ticketStore';
import type { Agent, AttachmentRef, Scope, TestType } from '../lib/types';
import { Icon } from './Icon';

export interface ComposerSubmit {
  text: string;
  agent: Agent;
  scope: Scope;
  testType: TestType | null;
  /** 'user' when the user picked the type, so the model may not change it. */
  testTypeSource: 'user' | 'rules' | null;
  tickets: string[];
  components: string[];
  /** Files the server has stored for this message. */
  attachments?: AttachmentRef[];
}

/** A file in the composer: uploading, stored on the server (readable or not), or refused. */
interface AttachedFile {
  key: string;
  name: string;
  state: 'uploading' | 'ready' | 'stored' | 'failed';
  id?: string;
  note?: string | null;
}

const FILE_STATE: Record<AttachedFile['state'], string> = { uploading: 'uploading…', ready: '', stored: 'kept, not readable', failed: 'not attached' };

interface ComposerProps {
  placeholder?: string;
  onSubmit: (value: ComposerSubmit) => void;
  /** Lets the home page pre-fill a capability example. */
  value?: string;
  onValueChange?: (v: string) => void;
  initialAgent?: Agent;
  initialScope?: Scope;
  /** While an answer is being written the send button becomes Stop. */
  busy?: boolean;
  onStop?: () => void;
}

/**
 * Message box: text, the + menu (files, Jira tickets, components), the agent picker (Auto by
 * default) and the application and workspace picker. Asking before acting is always on, so there
 * is no control for it.
 *
 * It also shows whether the request is UAT or regression, detected by rules as the user types
 * (see lib/testType.ts). The user can switch it with one click; when the signals conflict it asks.
 */
export function Composer({
  placeholder = 'Reply to Catalyzt',
  onSubmit,
  value,
  onValueChange,
  initialAgent = 'auto',
  initialScope,
  busy = false,
  onStop,
}: ComposerProps) {
  const { me } = useSession();
  const app = me?.app ?? null;
  const scopes = useMemo<Scope[]>(() => (app ? app.workspaces.map((w) => ({ appName: app.name, appId: app.id, workspace: w })) : []), [app]);
  const allComponents = app?.components.map((c) => c.name) ?? [];
  const [ownText, setOwnText] = useState('');
  const text = value ?? ownText;
  const setText = onValueChange ?? setOwnText;
  const [agent, setAgent] = useState<Agent>(initialAgent);
  const [chosenScope, setScope] = useState<Scope | null>(initialScope ?? null);
  const scope: Scope = chosenScope ?? scopes[0] ?? { appName: '', appId: '', workspace: '' };
  const [tickets, setTickets] = useState<string[]>([]);
  const [comps, setComps] = useState<string[]>([]);
  const [override, setOverride] = useState<TestType | null>(null);
  const [files, setFiles] = useState<AttachedFile[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);
  const synced = useTickets();

  const detection = useMemo(() => detectTestType(text, { tickets, components: comps }), [text, tickets, comps]);
  const testType = override ?? detection.type;
  const needsChoice = detection.ambiguous && !override;
  const showType = testType !== null || detection.ambiguous;

  // F15: chips belong to the person and application that attached them; a new sign-in or application starts clean.
  useEffect(() => {
    const clear = () => setFiles([]);
    window.addEventListener('hz:session', clear);
    return () => window.removeEventListener('hz:session', clear);
  }, []);

  const uploading = files.some((f) => f.state === 'uploading');
  const canSend = text.trim().length > 0 && !needsChoice && !busy && !!app && !uploading;

  // Each file goes to the server as soon as it is chosen; its chip shows what the server said.
  const attach = (picked: File[]) => {
    const added = picked.map((f): AttachedFile => ({ key: `${f.name}-${f.size}-${crypto.randomUUID().slice(0, 8)}`, name: f.name, state: 'uploading' }));
    setFiles((cur) => [...cur, ...added]);
    picked.forEach((f, i) => {
      const key = added[i].key;
      uploadAttachment(f).then(
        (a) => setFiles((cur) => cur.map((x) => (x.key === key ? { ...x, state: a.status === 'ready' ? 'ready' : 'stored', id: a.id, note: a.note } : x))),
        (e: Error) => setFiles((cur) => cur.map((x) => (x.key === key ? { ...x, state: 'failed', note: e.message } : x))),
      );
    });
  };

  const reset = () => {
    setText('');
    setTickets([]);
    setComps([]);
    setFiles([]);
    setOverride(null);
  };

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (!canSend) return;
    onSubmit({
      text: text.trim(),
      agent,
      scope,
      testType,
      testTypeSource: override ? 'user' : testType ? 'rules' : null,
      tickets: detection.tickets,
      components: comps,
      // Only files the server holds go with the message; a refused upload is never sent.
      attachments: files.filter((f): f is AttachedFile & { id: string } => !!f.id && f.state !== 'failed').map((f) => ({ id: f.id, filename: f.name, status: f.state === 'ready' ? 'ready' : 'stored' })),
    });
    reset();
  };

  // Enter sends; Shift+Enter adds a line.
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) submit(e);
  };

  const add = (list: string[], set: (v: string[]) => void, v: string) => !list.includes(v) && set([...list, v]);
  const chips = [
    ...tickets.map((k) => ({ key: `t-${k}`, icon: 'doc' as const, label: k, state: '', title: undefined as string | undefined, cls: '', remove: () => setTickets(tickets.filter((x) => x !== k)) })),
    ...comps.map((c) => ({ key: `c-${c}`, icon: 'codeic' as const, label: c, state: '', title: undefined as string | undefined, cls: '', remove: () => setComps(comps.filter((x) => x !== c)) })),
    ...files.map((f) => ({
      key: `f-${f.key}`,
      icon: 'clip' as const,
      label: f.name,
      state: FILE_STATE[f.state],
      title: f.note ?? undefined,
      cls: f.state === 'ready' ? '' : ` ${f.state}`,
      remove: () => setFiles(files.filter((x) => x.key !== f.key)),
    })),
  ];

  return (
    <form className="composer" onSubmit={submit}>
      {chips.length > 0 && (
        <div className="items">
          {chips.map((c) => (
            <span key={c.key} className={`itemchip${c.cls}`} title={c.title} aria-busy={c.state === 'uploading…' || undefined}>
              <Icon name={c.icon} small />
              {c.label}
              {c.state && <em className="muted"> · {c.state}</em>}
              <button type="button" className="chipx" aria-label={`Remove ${c.label}`} onClick={c.remove}>
                <Icon name="close" small />
              </button>
            </span>
          ))}
        </div>
      )}
      <textarea
        className="input"
        rows={1}
        placeholder={placeholder}
        aria-label="Message"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
      />

      {showType && (
        <div className="testtype" role="group" aria-label="Test type">
          <span className="tt-label">
            {needsChoice ? (
              <>
                <Icon name="warn" small />
                UAT or regression? <span className="muted">The request has {detection.reason}.</span>
              </>
            ) : (
              <>
                {testTypeLabel(testType!)}
                <span className="muted">
                  {override && override !== detection.type ? ' · chosen by you' : detection.reason ? ` · ${detection.reason}` : ''}
                </span>
              </>
            )}
          </span>
          <span className="segctl" role="radiogroup" aria-label="Choose test type">
            {(['uat', 'regression'] as const).map((t) => (
              <button
                key={t}
                type="button"
                role="radio"
                aria-checked={testType === t}
                className={testType === t ? 'on' : undefined}
                onClick={() => setOverride(t)}
              >
                {testTypeLabel(t)}
              </button>
            ))}
          </span>
        </div>
      )}

      <div className="row">
        <Dropdown.Root>
          <Dropdown.Trigger asChild>
            <button type="button" className="icon" aria-label="Add files, a Jira story or a component">
              <Icon name="plus" />
            </button>
          </Dropdown.Trigger>
          <Dropdown.Portal>
            <Dropdown.Content className="menu-content" sideOffset={6} align="start">
              <Dropdown.Item className="menu-item" onSelect={() => fileInput.current?.click()}>
                <span className="mi">
                  <Icon name="clip" small />
                  Attach files
                </span>
              </Dropdown.Item>
              <Dropdown.Sub>
                <Dropdown.SubTrigger className="menu-item">
                  <span className="mi">
                    <Icon name="doc" small />
                    Jira story
                    <span className="menu-hint inline">means UAT</span>
                  </span>
                  <Icon name="right" small />
                </Dropdown.SubTrigger>
                <Dropdown.Portal>
                  <Dropdown.SubContent className="menu-content wide-menu" sideOffset={4}>
                    <Dropdown.Label className="menu-label">Synced from Jira · paste a link to add any other</Dropdown.Label>
                    {synced.map((t) => (
                      <Dropdown.Item key={t.key} className="menu-item" onSelect={() => add(tickets, setTickets, t.key)}>
                        <span>
                          <span className="mono">{t.key}</span> {t.summary}
                        </span>
                      </Dropdown.Item>
                    ))}
                  </Dropdown.SubContent>
                </Dropdown.Portal>
              </Dropdown.Sub>
              <Dropdown.Sub>
                <Dropdown.SubTrigger className="menu-item">
                  <span className="mi">
                    <Icon name="codeic" small />
                    Component
                    <span className="menu-hint inline">means regression</span>
                  </span>
                  <Icon name="right" small />
                </Dropdown.SubTrigger>
                <Dropdown.Portal>
                  <Dropdown.SubContent className="menu-content" sideOffset={4}>
                    {allComponents.map((c) => (
                      <Dropdown.Item key={c} className="menu-item" onSelect={() => add(comps, setComps, c)}>
                        <span className="mono">{c}</span>
                      </Dropdown.Item>
                    ))}
                  </Dropdown.SubContent>
                </Dropdown.Portal>
              </Dropdown.Sub>
            </Dropdown.Content>
          </Dropdown.Portal>
        </Dropdown.Root>
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            attach([...(e.target.files ?? [])]);
            e.target.value = '';
          }}
        />

        <Picker
          className="keep"
          icon="auto"
          label={agentLabel(agent)}
          kind="Agent"
          items={[
            { key: 'auto', label: 'Auto', hint: 'Catalyzt picks the capability' },
            ...capabilities.map((c) => ({ key: c.id, label: c.name })),
          ]}
          selected={agent}
          onSelect={(k) => setAgent(k as Agent)}
        />

        <Picker
          icon="layers"
          label={scopeLabel(scope)}
          shortLabel={`${scope.appId} · ${scope.workspace}`}
          kind="Scope"
          items={scopes.map((s) => ({ key: scopeLabel(s), label: scopeLabel(s) }))}
          selected={scopeLabel(scope)}
          onSelect={(k) => setScope(scopes.find((s) => scopeLabel(s) === k) ?? scope)}
        />

        {busy ? (
          <button type="button" className="send stop" aria-label="Stop the answer" onClick={onStop}>
            <Icon name="stop" />
          </button>
        ) : (
          <button
            type="submit"
            className="send"
            aria-label={needsChoice ? 'Send (choose UAT or regression first)' : uploading ? 'Send (waiting for files to upload)' : 'Send'}
            disabled={!canSend}
          >
            <Icon name="send" />
          </button>
        )}
      </div>
    </form>
  );
}

interface PickerProps {
  className?: string;
  icon: 'auto' | 'layers';
  label: string;
  shortLabel?: string;
  /** Read before the visible label by assistive technology, e.g. "Scope". */
  kind: string;
  items: { key: string; label: string; hint?: string }[];
  selected: string;
  onSelect: (key: string) => void;
}

function Picker({ className, icon, label, shortLabel, kind, items, selected, onSelect }: PickerProps) {
  return (
    <Dropdown.Root>
      <Dropdown.Trigger asChild>
        <button type="button" className={`pick${className ? ` ${className}` : ''}`}>
          <Icon name={icon} small />
          <span className="sr">{kind}: </span>
          {shortLabel ? (
            <>
              <span className="pl wide">{label}</span>
              <span className="pl short">{shortLabel}</span>
            </>
          ) : (
            <span className="pl">{label}</span>
          )}
          <Icon name="down" small />
        </button>
      </Dropdown.Trigger>
      <Dropdown.Portal>
        <Dropdown.Content className="menu-content" sideOffset={6} align="start">
          <Dropdown.RadioGroup value={selected} onValueChange={onSelect}>
            {items.map((it) => (
              <Dropdown.RadioItem key={it.key} value={it.key} className="menu-item">
                <span>
                  {it.label}
                  {it.hint && <span className="menu-hint">{it.hint}</span>}
                </span>
                <Dropdown.ItemIndicator className="menu-check">
                  <Icon name="check" small />
                </Dropdown.ItemIndicator>
              </Dropdown.RadioItem>
            ))}
          </Dropdown.RadioGroup>
        </Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
  );
}
