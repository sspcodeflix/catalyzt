/**
 * Versioned schema for Horizon's database. See DATA_MODEL.md for the design.
 * Each migration runs once, in order, tracked by SQLite's user_version. Never edit a shipped
 * migration; add a new one.
 */
export const MIGRATIONS: string[] = [
  // 1: the full model.
  `
  -- People and scope -------------------------------------------------------------------------
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    initials TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL
  );
  CREATE TABLE applications (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    jira_project TEXT NOT NULL
  );
  CREATE TABLE workspaces (
    id TEXT PRIMARY KEY,
    application_id TEXT NOT NULL REFERENCES applications(id),
    name TEXT NOT NULL,
    UNIQUE (application_id, name)
  );
  CREATE TABLE memberships (
    user_id TEXT NOT NULL REFERENCES users(id),
    application_id TEXT NOT NULL REFERENCES applications(id),
    role TEXT NOT NULL CHECK (role IN ('member', 'app_owner', 'security_champion')),
    PRIMARY KEY (user_id, application_id, role)
  );
  CREATE TABLE components (
    id TEXT PRIMARY KEY,
    application_id TEXT NOT NULL REFERENCES applications(id),
    name TEXT NOT NULL,
    repo TEXT,
    indexed_commit TEXT,
    UNIQUE (application_id, name)
  );
  CREATE TABLE requirements (
    id TEXT PRIMARY KEY,
    application_id TEXT NOT NULL REFERENCES applications(id),
    title TEXT NOT NULL DEFAULT '',
    source_id TEXT
  );

  -- Conversations ----------------------------------------------------------------------------
  CREATE TABLE chats (
    id TEXT PRIMARY KEY,
    application_id TEXT NOT NULL REFERENCES applications(id),
    workspace_id TEXT REFERENCES workspaces(id),
    title TEXT NOT NULL,
    agent TEXT NOT NULL DEFAULT 'auto',
    test_type TEXT CHECK (test_type IN ('uat', 'regression')),
    created_by TEXT NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    text TEXT NOT NULL DEFAULT '',
    test_type TEXT CHECK (test_type IN ('uat', 'regression')),
    test_type_source TEXT CHECK (test_type_source IN ('user', 'rules', 'model')),
    removed_reason TEXT,
    created_by TEXT REFERENCES users(id),
    created_at TEXT NOT NULL,
    UNIQUE (chat_id, seq)
  );
  CREATE TABLE message_items (
    message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    item_type TEXT NOT NULL CHECK (item_type IN ('story', 'component', 'file', 'source')),
    item_ref TEXT NOT NULL,
    PRIMARY KEY (message_id, item_type, item_ref)
  );
  CREATE TABLE answer_revisions (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('working', 'streaming', 'done', 'error', 'stopped')),
    intent TEXT,
    blocks TEXT NOT NULL DEFAULT '[]',
    workflow_run_id TEXT REFERENCES workflow_runs(id),
    created_at TEXT NOT NULL,
    UNIQUE (message_id, revision)
  );
  CREATE TABLE citations (
    revision_id TEXT NOT NULL REFERENCES answer_revisions(id) ON DELETE CASCADE,
    n INTEGER NOT NULL,
    source_type TEXT NOT NULL,
    source_ref TEXT NOT NULL,
    title TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (revision_id, n)
  );
  CREATE TABLE ratings (
    revision_id TEXT NOT NULL REFERENCES answer_revisions(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id),
    stars INTEGER NOT NULL CHECK (stars BETWEEN 1 AND 5),
    reasons TEXT NOT NULL DEFAULT '[]',
    comment TEXT,
    refined_comment TEXT,
    used_refined INTEGER NOT NULL DEFAULT 0,
    selection TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (revision_id, user_id)
  );
  CREATE TABLE artifacts (
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    revision_id TEXT REFERENCES answer_revisions(id),
    kind TEXT NOT NULL CHECK (kind IN ('code', 'uat_report', 'coverage_report')),
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE approvals (
    id TEXT PRIMARY KEY,
    revision_id TEXT NOT NULL REFERENCES answer_revisions(id),
    action TEXT NOT NULL CHECK (action IN ('open_pr', 'add_uat_cases', 'gitops_change', 'other')),
    target TEXT NOT NULL DEFAULT '{}',
    facts TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'declined', 'expired')),
    decided_by TEXT REFERENCES users(id),
    decided_at TEXT,
    created_at TEXT NOT NULL
  );

  -- Agents and guardrails --------------------------------------------------------------------
  CREATE TABLE workflow_runs (
    id TEXT PRIMARY KEY,
    chat_id TEXT REFERENCES chats(id) ON DELETE SET NULL,
    message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
    revision INTEGER NOT NULL DEFAULT 1,
    requested_by TEXT NOT NULL REFERENCES users(id),
    status TEXT NOT NULL CHECK (status IN ('running', 'done', 'failed', 'rejected', 'stopped')),
    summary TEXT,
    started_at TEXT NOT NULL,
    ended_at TEXT
  );
  CREATE INDEX workflow_runs_status ON workflow_runs (status, started_at);
  CREATE TABLE agent_runs (
    id TEXT PRIMARY KEY,
    workflow_run_id TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
    parent_id TEXT REFERENCES agent_runs(id),
    agent TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('orchestrator', 'guard', 'router', 'specialist', 'tool_agent', 'refiner')),
    task TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('running', 'done', 'failed', 'rejected', 'stopped')),
    model TEXT,
    prompt_tokens INTEGER,
    completion_tokens INTEGER,
    result TEXT,
    error TEXT,
    started_at TEXT NOT NULL,
    ended_at TEXT
  );
  CREATE INDEX agent_runs_status ON agent_runs (status, started_at);
  CREATE INDEX agent_runs_workflow ON agent_runs (workflow_run_id);
  CREATE TABLE agent_steps (
    id TEXT PRIMARY KEY,
    agent_run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('rule', 'model', 'tool')),
    tool TEXT,
    label TEXT NOT NULL,
    detail TEXT,
    status TEXT NOT NULL CHECK (status IN ('running', 'done', 'failed')),
    started_at TEXT NOT NULL,
    ended_at TEXT,
    UNIQUE (agent_run_id, seq)
  );
  CREATE TABLE guard_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workflow_run_id TEXT REFERENCES workflow_runs(id) ON DELETE SET NULL,
    agent_run_id TEXT REFERENCES agent_runs(id) ON DELETE SET NULL,
    layer TEXT NOT NULL CHECK (layer IN ('input', 'router', 'output', 'story')),
    policy TEXT NOT NULL,
    user_id TEXT REFERENCES users(id),
    created_at TEXT NOT NULL
  );
  CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL,
    actor_type TEXT NOT NULL CHECK (actor_type IN ('user', 'agent', 'system')),
    actor_ref TEXT NOT NULL,
    action TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_ref TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '{}'
  );

  -- Jira and UAT -----------------------------------------------------------------------------
  CREATE TABLE jira_sync (
    application_id TEXT PRIMARY KEY REFERENCES applications(id),
    project TEXT NOT NULL,
    statuses TEXT NOT NULL,
    every_minutes INTEGER NOT NULL CHECK (every_minutes BETWEEN 5 AND 1440),
    last_sync_at TEXT NOT NULL,
    updated_by TEXT REFERENCES users(id)
  );
  CREATE TABLE refinements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    story_key TEXT REFERENCES stories(key) ON DELETE SET NULL,
    input TEXT NOT NULL,
    output TEXT NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('model', 'rules')),
    model TEXT,
    agent_run_id TEXT REFERENCES agent_runs(id) ON DELETE SET NULL,
    created_by TEXT NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL
  );
  CREATE TABLE stories (
    key TEXT PRIMARY KEY,
    application_id TEXT NOT NULL REFERENCES applications(id),
    project TEXT NOT NULL,
    number INTEGER NOT NULL,
    summary TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    type TEXT NOT NULL CHECK (type IN ('Story', 'Bug', 'Task')),
    status TEXT NOT NULL CHECK (status IN ('To Do', 'In Progress', 'Ready for UAT', 'Done')),
    fix_version TEXT NOT NULL DEFAULT '',
    assignee TEXT NOT NULL DEFAULT '',
    original TEXT,
    refinement_id INTEGER REFERENCES refinements(id),
    source TEXT NOT NULL CHECK (source IN ('jira_sync', 'horizon')),
    created_by TEXT NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (project, number)
  );
  CREATE INDEX stories_status ON stories (application_id, status, updated_at);
  CREATE TABLE story_criteria (
    story_key TEXT NOT NULL REFERENCES stories(key) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    text TEXT NOT NULL,
    PRIMARY KEY (story_key, seq)
  );
  CREATE TABLE story_components (
    story_key TEXT NOT NULL REFERENCES stories(key) ON DELETE CASCADE,
    component_id TEXT NOT NULL REFERENCES components(id),
    PRIMARY KEY (story_key, component_id)
  );
  CREATE TABLE story_requirements (
    story_key TEXT NOT NULL REFERENCES stories(key) ON DELETE CASCADE,
    requirement_id TEXT NOT NULL REFERENCES requirements(id),
    PRIMARY KEY (story_key, requirement_id)
  );
  CREATE TABLE uat_analyses (
    id TEXT PRIMARY KEY,
    story_key TEXT NOT NULL REFERENCES stories(key) ON DELETE CASCADE,
    chat_id TEXT REFERENCES chats(id) ON DELETE SET NULL,
    workflow_run_id TEXT REFERENCES workflow_runs(id) ON DELETE SET NULL,
    state TEXT NOT NULL CHECK (state IN ('gaps', 'ready')),
    covered INTEGER NOT NULL,
    not_run INTEGER NOT NULL,
    no_test INTEGER NOT NULL,
    created_by TEXT NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL
  );
  CREATE TABLE uat_criterion_results (
    analysis_id TEXT NOT NULL REFERENCES uat_analyses(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('passing', 'not_run', 'no_test')),
    evidence TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (analysis_id, seq)
  );

  -- Knowledge and decisions ------------------------------------------------------------------
  CREATE TABLE context_sources (
    id TEXT PRIMARY KEY,
    application_id TEXT NOT NULL REFERENCES applications(id),
    scope_type TEXT NOT NULL CHECK (scope_type IN ('app', 'workspace', 'chat')),
    scope_ref TEXT,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    trust TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('ready', 'indexed', 'review', 'processing', 'failed')),
    stage INTEGER,
    created_by TEXT REFERENCES users(id),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE source_chunks (
    id TEXT PRIMARY KEY,
    source_id TEXT NOT NULL REFERENCES context_sources(id) ON DELETE CASCADE,
    locator TEXT NOT NULL,
    text TEXT NOT NULL,
    excluded_reason TEXT
  );
  CREATE TABLE huddle_items (
    id TEXT PRIMARY KEY,
    application_id TEXT NOT NULL REFERENCES applications(id),
    kind TEXT NOT NULL CHECK (kind IN ('conflict', 'mapping', 'risk', 'feedback')),
    title TEXT NOT NULL,
    summary TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'decided')),
    needs_input INTEGER NOT NULL DEFAULT 0,
    raised_by_type TEXT NOT NULL CHECK (raised_by_type IN ('user', 'agent')),
    raised_by TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE conflicts (
    id TEXT PRIMARY KEY,
    source_id TEXT NOT NULL REFERENCES context_sources(id) ON DELETE CASCADE,
    other_source_id TEXT REFERENCES context_sources(id),
    summary TEXT NOT NULL,
    huddle_item_id TEXT REFERENCES huddle_items(id),
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved'))
  );
  CREATE TABLE huddle_options (
    id TEXT PRIMARY KEY,
    item_id TEXT NOT NULL REFERENCES huddle_items(id) ON DELETE CASCADE,
    label TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE huddle_votes (
    item_id TEXT NOT NULL REFERENCES huddle_items(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id),
    option_id TEXT NOT NULL REFERENCES huddle_options(id) ON DELETE CASCADE,
    PRIMARY KEY (item_id, user_id)
  );
  CREATE TABLE huddle_comments (
    id TEXT PRIMARY KEY,
    item_id TEXT NOT NULL REFERENCES huddle_items(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id),
    text TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE huddle_decisions (
    item_id TEXT PRIMARY KEY REFERENCES huddle_items(id) ON DELETE CASCADE,
    option_id TEXT NOT NULL REFERENCES huddle_options(id),
    reason TEXT NOT NULL,
    decided_by TEXT NOT NULL REFERENCES users(id),
    decided_at TEXT NOT NULL
  );
  CREATE TABLE huddle_links (
    item_id TEXT NOT NULL REFERENCES huddle_items(id) ON DELETE CASCADE,
    entity_type TEXT NOT NULL,
    entity_ref TEXT NOT NULL,
    PRIMARY KEY (item_id, entity_type, entity_ref)
  );
  `,
  // 2: the token ledger. One row per model call, so totals can be cut by agent, model, user and day.
  `
  CREATE TABLE model_calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workflow_run_id TEXT REFERENCES workflow_runs(id) ON DELETE SET NULL,
    agent_run_id TEXT REFERENCES agent_runs(id) ON DELETE SET NULL,
    agent TEXT NOT NULL,
    user_id TEXT REFERENCES users(id),
    model TEXT NOT NULL,
    purpose TEXT NOT NULL CHECK (purpose IN ('intent', 'answer', 'refine')),
    status TEXT NOT NULL CHECK (status IN ('ok', 'error', 'stopped')),
    -- NULL when the provider did not report usage (for example a stopped stream).
    prompt_tokens INTEGER,
    completion_tokens INTEGER,
    latency_ms INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX model_calls_created ON model_calls (created_at);
  CREATE INDEX model_calls_agent ON model_calls (agent, created_at);
  `,
  // 3: Hexa, the test case inventory: test cases from repo scans and from agents, linked to what they cover.
  `
  CREATE TABLE repo_scans (
    id TEXT PRIMARY KEY,
    application_id TEXT NOT NULL REFERENCES applications(id),
    repo TEXT NOT NULL,
    ref TEXT,
    sha TEXT,
    status TEXT NOT NULL CHECK (status IN ('running', 'done', 'failed')),
    files_found INTEGER,
    files_scanned INTEGER,
    tests_found INTEGER,
    tests_new INTEGER,
    tests_removed INTEGER,
    truncated INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    workflow_run_id TEXT REFERENCES workflow_runs(id) ON DELETE SET NULL,
    started_by TEXT NOT NULL REFERENCES users(id),
    started_at TEXT NOT NULL,
    ended_at TEXT
  );
  CREATE INDEX repo_scans_repo ON repo_scans (repo, started_at);
  CREATE TABLE test_cases (
    id TEXT PRIMARY KEY,
    application_id TEXT NOT NULL REFERENCES applications(id),
    title TEXT NOT NULL,
    suite TEXT,
    kind TEXT NOT NULL CHECK (kind IN ('automated', 'manual', 'proposed')),
    framework TEXT,
    origin TEXT NOT NULL CHECK (origin IN ('repo_scan', 'uat_analyst', 'authoring', 'manual')),
    repo TEXT,
    ref TEXT,
    path TEXT,
    line INTEGER,
    url TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'removed')),
    last_result TEXT CHECK (last_result IN ('passed', 'failed', 'not_run')),
    last_run_at TEXT,
    scan_id TEXT REFERENCES repo_scans(id) ON DELETE SET NULL,
    created_by TEXT REFERENCES users(id),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX test_cases_repo ON test_cases (repo, status);
  CREATE INDEX test_cases_kind ON test_cases (application_id, kind, status);
  CREATE TABLE test_case_links (
    test_case_id TEXT NOT NULL REFERENCES test_cases(id) ON DELETE CASCADE,
    entity_type TEXT NOT NULL CHECK (entity_type IN ('story', 'criterion', 'requirement', 'component')),
    entity_ref TEXT NOT NULL,
    PRIMARY KEY (test_case_id, entity_type, entity_ref)
  );
  CREATE INDEX test_case_links_ref ON test_case_links (entity_type, entity_ref);
  `,
  // 4: Hexa holds manual tests (Octane format) and automated test results from CI.
  //    test_cases is rebuilt to allow the new origins and add the Octane fields.
  `
  CREATE TABLE test_cases_v4 (
    id TEXT PRIMARY KEY,
    application_id TEXT NOT NULL REFERENCES applications(id),
    title TEXT NOT NULL,
    suite TEXT,
    -- The function or method name in code, used to match CI results to the test.
    code_name TEXT,
    kind TEXT NOT NULL CHECK (kind IN ('automated', 'manual', 'proposed')),
    purpose TEXT CHECK (purpose IN ('uat', 'regression')),
    framework TEXT,
    origin TEXT NOT NULL CHECK (origin IN ('repo_scan', 'uat_analyst', 'authoring', 'manual', 'upload', 'ci_results')),
    repo TEXT,
    ref TEXT,
    path TEXT,
    line INTEGER,
    url TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'removed')),
    last_result TEXT CHECK (last_result IN ('passed', 'failed', 'skipped', 'not_run')),
    last_run_at TEXT,
    scan_id TEXT REFERENCES repo_scans(id) ON DELETE SET NULL,
    -- Octane fields, for manual tests.
    external_id TEXT,
    description TEXT,
    test_type TEXT,
    phase TEXT,
    owner TEXT,
    designer TEXT,
    product_areas TEXT,
    application_modules TEXT,
    user_tags TEXT,
    estimated_minutes INTEGER,
    upload_id TEXT,
    created_by TEXT REFERENCES users(id),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  INSERT INTO test_cases_v4 (id, application_id, title, suite, kind, framework, origin, repo, ref, path, line, url, status, last_result, last_run_at, scan_id, created_by, created_at, updated_at)
    SELECT id, application_id, title, suite, kind, framework, origin, repo, ref, path, line, url, status, last_result, last_run_at, scan_id, created_by, created_at, updated_at FROM test_cases;
  DROP TABLE test_cases;
  ALTER TABLE test_cases_v4 RENAME TO test_cases;
  CREATE INDEX test_cases_repo ON test_cases (repo, status);
  CREATE INDEX test_cases_kind ON test_cases (application_id, kind, status);
  CREATE INDEX test_cases_code ON test_cases (repo, code_name);
  CREATE UNIQUE INDEX test_cases_external ON test_cases (application_id, external_id) WHERE external_id IS NOT NULL;

  -- Steps of a manual test, as in Octane: simple, validation (with an expected result) or call (another test).
  CREATE TABLE test_steps (
    test_case_id TEXT NOT NULL REFERENCES test_cases(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    step_type TEXT NOT NULL CHECK (step_type IN ('simple', 'validation', 'call')),
    description TEXT NOT NULL,
    PRIMARY KEY (test_case_id, seq)
  );

  -- Each upload is kept, with what it changed and any rows it could not use.
  CREATE TABLE hexa_uploads (
    id TEXT PRIMARY KEY,
    application_id TEXT NOT NULL REFERENCES applications(id),
    kind TEXT NOT NULL CHECK (kind IN ('manual_tests', 'test_results')),
    filename TEXT NOT NULL,
    format TEXT NOT NULL,
    created INTEGER NOT NULL DEFAULT 0,
    updated INTEGER NOT NULL DEFAULT 0,
    problems TEXT NOT NULL DEFAULT '[]',
    uploaded_by TEXT NOT NULL REFERENCES users(id),
    uploaded_at TEXT NOT NULL
  );

  -- One CI run (or one uploaded results file), and the result of each test in it.
  CREATE TABLE test_runs (
    id TEXT PRIMARY KEY,
    application_id TEXT NOT NULL REFERENCES applications(id),
    source TEXT NOT NULL CHECK (source IN ('github_actions', 'webhook', 'upload')),
    repo TEXT,
    workflow TEXT,
    external_run_id TEXT,
    run_url TEXT,
    event TEXT,
    branch TEXT,
    sha TEXT,
    pr_number INTEGER,
    is_merge INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL CHECK (status IN ('passed', 'failed')),
    total INTEGER NOT NULL,
    passed INTEGER NOT NULL,
    failed INTEGER NOT NULL,
    skipped INTEGER NOT NULL,
    duration_ms INTEGER,
    started_at TEXT,
    ingested_by TEXT REFERENCES users(id),
    ingested_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX test_runs_external ON test_runs (source, repo, external_run_id) WHERE external_run_id IS NOT NULL;
  CREATE INDEX test_runs_time ON test_runs (application_id, ingested_at);
  CREATE TABLE test_results (
    run_id TEXT NOT NULL REFERENCES test_runs(id) ON DELETE CASCADE,
    test_case_id TEXT NOT NULL REFERENCES test_cases(id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK (status IN ('passed', 'failed', 'skipped')),
    duration_ms INTEGER,
    message TEXT,
    PRIMARY KEY (run_id, test_case_id)
  );
  CREATE INDEX test_results_case ON test_results (test_case_id);
  `,
];
