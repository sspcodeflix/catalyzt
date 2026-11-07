import * as Dropdown from '@radix-ui/react-dropdown-menu';
import { useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';

import { agentLabel, capabilities, components as allComponents, scopeLabel, scopes } from '../lib/data';
import { detectTestType, testTypeLabel } from '../lib/testType';
import { useTickets } from '../lib/ticketStore';
import type { Agent, Scope, TestType } from '../lib/types';
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
}

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
  placeholder = 'Reply to Horizon',
  onSubmit,
  value,
  onValueChange,
  initialAgent = 'auto',
  initialScope = scopes[0],
  busy = false,
  onStop,
}: ComposerProps) {
  const [ownText, setOwnText] = useState('');
  const text = value ?? ownText;
  const setText = onValueChange ?? setOwnText;
  const [agent, setAgent] = useState<Agent>(initialAgent);
  const [scope, setScope] = useState<Scope>(initialScope);
  const [tickets, setTickets] = useState<string[]>([]);
  const [comps, setComps] = useState<string[]>([]);
  const [override, setOverride] = useState<TestType | null>(null);
  const [files, setFiles] = useState<string[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);
  const synced = useTickets();

  const detection = useMemo(() => detectTestType(text, { tickets, components: comps }), [text, tickets, comps]);
  const testType = override ?? detection.type;
  const needsChoice = detection.ambiguous && !override;
  const showType = testType !== null || detection.ambiguous;

  const canSend = text.trim().length > 0 && !needsChoice && !busy;

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
    });
    reset();
  };

  // Enter sends; Shift+Enter adds a line.
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) submit(e);
  };

  const add = (list: string[], set: (v: string[]) => void, v: string) => !list.includes(v) && set([...list, v]);
  const chips = [
    ...tickets.map((k) => ({ key: `t-${k}`, icon: 'doc' as const, label: k, remove: () => setTickets(tickets.filter((x) => x !== k)) })),
    ...comps.map((c) => ({ key: `c-${c}`, icon: 'codeic' as const, label: c, remove: () => setComps(comps.filter((x) => x !== c)) })),
    ...files.map((f) => ({ key: `f-${f}`, icon: 'clip' as const, label: f, remove: () => setFiles(files.filter((x) => x !== f)) })),
  ];

  return (
    <form className="composer" onSubmit={submit}>
      {chips.length > 0 && (
        <div className="items">
          {chips.map((c) => (
            <span key={c.key} className="itemchip">
              <Icon name={c.icon} small />
              {c.label}
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
            const names = [...(e.target.files ?? [])].map((f) => f.name);
            setFiles([...new Set([...files, ...names])]);
            e.target.value = '';
          }}
        />

        <Picker
          className="keep"
          icon="auto"
          label={agentLabel(agent)}
          ariaLabel={`Agent: ${agentLabel(agent)}`}
          items={[
            { key: 'auto', label: 'Auto', hint: 'Horizon picks the capability' },
            ...capabilities.map((c) => ({ key: c.id, label: c.name })),
          ]}
          selected={agent}
          onSelect={(k) => setAgent(k as Agent)}
        />

        <Picker
          icon="layers"
          label={scopeLabel(scope)}
          shortLabel={`${scope.appId.replace('App-', '').toUpperCase()} · ${scope.workspace}`}
          ariaLabel={`Scope: ${scopeLabel(scope)}`}
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
            aria-label={needsChoice ? 'Send (choose UAT or regression first)' : 'Send'}
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
  ariaLabel: string;
  items: { key: string; label: string; hint?: string }[];
  selected: string;
  onSelect: (key: string) => void;
}

function Picker({ className, icon, label, shortLabel, ariaLabel, items, selected, onSelect }: PickerProps) {
  return (
    <Dropdown.Root>
      <Dropdown.Trigger asChild>
        <button type="button" className={`pick${className ? ` ${className}` : ''}`} aria-label={ariaLabel}>
          <Icon name={icon} small />
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
