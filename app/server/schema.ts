/**
 * Versioned schema for Catalyzt's database. See DATA_MODEL.md for the design.
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
  // 5: real teams. Component managers as a role; components carry their manager, workspace, repo path,
  //    language and test framework; stories carry purpose and assignee; workflow runs carry their application.
  `
  ALTER TABLE applications ADD COLUMN description TEXT NOT NULL DEFAULT '';

  CREATE TABLE memberships_v5 (
    user_id TEXT NOT NULL REFERENCES users(id),
    application_id TEXT NOT NULL REFERENCES applications(id),
    role TEXT NOT NULL CHECK (role IN ('member', 'app_owner', 'component_manager', 'security_champion')),
    PRIMARY KEY (user_id, application_id, role)
  );
  INSERT INTO memberships_v5 SELECT user_id, application_id, role FROM memberships;
  DROP TABLE memberships;
  ALTER TABLE memberships_v5 RENAME TO memberships;

  -- Component ids become "<application>/<name>", so two applications can both have a "frontend".
  CREATE TABLE components_v5 (
    id TEXT PRIMARY KEY,
    application_id TEXT NOT NULL REFERENCES applications(id),
    name TEXT NOT NULL,
    manager_id TEXT REFERENCES users(id),
    workspace_id TEXT REFERENCES workspaces(id),
    repo TEXT,
    path TEXT,
    language TEXT,
    tests TEXT,
    indexed_commit TEXT,
    UNIQUE (application_id, name)
  );
  INSERT INTO components_v5 (id, application_id, name, repo, indexed_commit)
    SELECT application_id || '/' || name, application_id, name, repo, indexed_commit FROM components;
  UPDATE story_components SET component_id = (SELECT application_id FROM stories WHERE stories.key = story_components.story_key) || '/' || component_id
    WHERE component_id NOT LIKE '%/%';
  DROP TABLE components;
  ALTER TABLE components_v5 RENAME TO components;

  ALTER TABLE stories ADD COLUMN purpose TEXT CHECK (purpose IN ('uat', 'regression'));
  ALTER TABLE stories ADD COLUMN assignee_id TEXT REFERENCES users(id);

  ALTER TABLE workflow_runs ADD COLUMN application_id TEXT REFERENCES applications(id);
  CREATE INDEX workflow_runs_app ON workflow_runs (application_id, started_at);
  `,
  // 6: App Context and Huddle move to the server. Sources carry what the list shows (subtitle, content,
  //    note, size, where they come from); conflicts keep their comparison; Huddle items keep their scope,
  //    Catalyzt's summary with citations and the source they came from; options are ordered and say
  //    whether choosing them means using the upload; links carry a label and a link.
  //    Only columns are added, so no table needs rebuilding.
  `
  ALTER TABLE context_sources ADD COLUMN subtitle TEXT NOT NULL DEFAULT '';
  ALTER TABLE context_sources ADD COLUMN href TEXT;
  ALTER TABLE context_sources ADD COLUMN content TEXT NOT NULL DEFAULT '';
  ALTER TABLE context_sources ADD COLUMN note TEXT;
  ALTER TABLE context_sources ADD COLUMN size_bytes INTEGER;
  -- Where the source is read from: the clone path of a repository, the URL of a Confluence page.
  ALTER TABLE context_sources ADD COLUMN location TEXT;
  ALTER TABLE context_sources ADD COLUMN synced_at TEXT;
  CREATE INDEX context_sources_app ON context_sources (application_id, created_at);
  CREATE INDEX source_chunks_source ON source_chunks (source_id);

  ALTER TABLE conflicts ADD COLUMN title TEXT NOT NULL DEFAULT '';
  ALTER TABLE conflicts ADD COLUMN detail TEXT NOT NULL DEFAULT '';
  ALTER TABLE conflicts ADD COLUMN compare TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE conflicts ADD COLUMN created_at TEXT;
  ALTER TABLE conflicts ADD COLUMN resolved_at TEXT;
  ALTER TABLE conflicts ADD COLUMN resolution TEXT CHECK (resolution IN ('keep_higher', 'use_upload'));
  CREATE INDEX conflicts_source ON conflicts (source_id, status);

  ALTER TABLE huddle_items ADD COLUMN scope TEXT NOT NULL DEFAULT '';
  ALTER TABLE huddle_items ADD COLUMN ai_summary TEXT NOT NULL DEFAULT '';
  ALTER TABLE huddle_items ADD COLUMN citations TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE huddle_items ADD COLUMN source_id TEXT REFERENCES context_sources(id) ON DELETE SET NULL;
  CREATE INDEX huddle_items_app ON huddle_items (application_id, status, created_at);
  ALTER TABLE huddle_options ADD COLUMN seq INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE huddle_options ADD COLUMN keeps_upload INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE huddle_votes ADD COLUMN created_at TEXT;
  ALTER TABLE huddle_links ADD COLUMN label TEXT NOT NULL DEFAULT '';
  ALTER TABLE huddle_links ADD COLUMN href TEXT;
  `,
  // 7: approvals bind to one immutable revision and carry the exact action payload they were shown
  //    with; outcomes and supersession are explicit; artifacts are stored per revision ("<revision>/<local id>")
  //    so a later revision can never change what an earlier approval would execute. Proposed UAT cases
  //    with the old per-story-number ids (which collided across applications) are retired; the next
  //    analysis recreates them under ids that include the full story key and criterion.
  `
  ALTER TABLE approvals ADD COLUMN payload TEXT NOT NULL DEFAULT '{}';
  ALTER TABLE approvals ADD COLUMN outcome TEXT;
  ALTER TABLE approvals ADD COLUMN executed_at TEXT;
  ALTER TABLE approvals ADD COLUMN superseded_by TEXT REFERENCES answer_revisions(id);
  CREATE INDEX approvals_revision ON approvals (revision_id, status);

  ALTER TABLE artifacts ADD COLUMN local_id TEXT NOT NULL DEFAULT '';
  UPDATE artifacts SET local_id = substr(id, length(chat_id) + 2);
  UPDATE artifacts SET id = revision_id || '/' || local_id WHERE revision_id IS NOT NULL;
  CREATE INDEX artifacts_revision ON artifacts (revision_id);
  CREATE INDEX chats_owner ON chats (application_id, created_by, updated_at);

  INSERT INTO audit_log (at, actor_type, actor_ref, action, entity_type, entity_ref, detail)
    SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'system', 'migration 7', 'hexa.proposal_retired', 'test_case', id,
           json_object('application', application_id, 'reason', 'proposal ids now include the story key and criterion; run the UAT analysis again to recreate it')
    FROM test_cases WHERE kind = 'proposed' AND id LIKE 'UAT-%';
  UPDATE test_cases SET status = 'removed', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE kind = 'proposed' AND id LIKE 'UAT-%';
  `,
  // 8: evidence against a build. Test runs carry the attempt (a rerun of the same CI run is a new
  //    row) and are unique per application, source, repository, run and attempt, so two applications
  //    watching one repository never swallow each other's deliveries. Scans record whether they were
  //    complete and how many files could not be read, so a partial scan never removes tests.
  `
  ALTER TABLE test_runs ADD COLUMN attempt INTEGER NOT NULL DEFAULT 1;
  DROP INDEX test_runs_external;
  CREATE UNIQUE INDEX test_runs_external ON test_runs (application_id, source, repo, external_run_id, attempt) WHERE external_run_id IS NOT NULL;
  CREATE INDEX test_runs_repo ON test_runs (application_id, repo, is_merge);
  ALTER TABLE repo_scans ADD COLUMN files_failed INTEGER;
  ALTER TABLE repo_scans ADD COLUMN complete INTEGER;
  `,
  // 9: attachments. The bytes live in the blob store under storage_key; SQLite holds the metadata,
  //    who uploaded it, which chat it belongs to once used, and the text Catalyzt could read.
  `
  CREATE TABLE attachments (
    id TEXT PRIMARY KEY,
    application_id TEXT NOT NULL REFERENCES applications(id),
    chat_id TEXT REFERENCES chats(id) ON DELETE SET NULL,
    filename TEXT NOT NULL,
    mime TEXT NOT NULL DEFAULT 'application/octet-stream',
    size INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    storage_key TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL CHECK (status IN ('ready', 'stored', 'failed')),
    note TEXT,
    text_chars INTEGER NOT NULL DEFAULT 0,
    created_by TEXT NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL
  );
  CREATE INDEX attachments_owner ON attachments (application_id, created_by, created_at);
  CREATE INDEX attachments_chat ON attachments (chat_id);
  CREATE TABLE attachment_text (
    attachment_id TEXT PRIMARY KEY REFERENCES attachments(id) ON DELETE CASCADE,
    text TEXT NOT NULL
  );
  `,
  // 10: App Context on the server. Sources gain 'stored' (kept, not readable in this build), a version
  //     for citations, the storage key of uploaded bytes and a content hash; the table is rebuilt because
  //     its CHECK constraint changes. Chunks carry their order, the source version they came from and
  //     their size. Huddle items keep an updated_at.
  `
  CREATE TABLE context_sources_v10 (
    id TEXT PRIMARY KEY,
    application_id TEXT NOT NULL REFERENCES applications(id),
    scope_type TEXT NOT NULL CHECK (scope_type IN ('app', 'workspace', 'chat')),
    scope_ref TEXT,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    trust TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('ready', 'indexed', 'review', 'processing', 'failed', 'stored')),
    stage INTEGER,
    created_by TEXT REFERENCES users(id),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    subtitle TEXT NOT NULL DEFAULT '',
    href TEXT,
    content TEXT NOT NULL DEFAULT '',
    note TEXT,
    size_bytes INTEGER,
    location TEXT,
    synced_at TEXT,
    version INTEGER NOT NULL DEFAULT 1,
    storage_key TEXT,
    sha256 TEXT,
    mime TEXT
  );
  INSERT INTO context_sources_v10 (id, application_id, scope_type, scope_ref, type, title, trust, status, stage, created_by, created_at, updated_at, subtitle, href, content, note, size_bytes, location, synced_at)
    SELECT id, application_id, scope_type, scope_ref, type, title, trust, status, stage, created_by, created_at, updated_at, subtitle, href, content, note, size_bytes, location, synced_at FROM context_sources;
  DROP TABLE context_sources;
  ALTER TABLE context_sources_v10 RENAME TO context_sources;
  CREATE INDEX context_sources_app ON context_sources (application_id, created_at);

  ALTER TABLE source_chunks ADD COLUMN seq INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE source_chunks ADD COLUMN source_version INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE source_chunks ADD COLUMN chars INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE huddle_items ADD COLUMN updated_at TEXT;
  `,
  // 11: hybrid retrieval. One vector per passage and embedding model (float32 little-endian BLOB,
  //     unit length), with the hash of the text it was computed from so a re-index can keep it.
  //     Removing a passage removes its vector; a model change leaves the old rows unused.
  `
  CREATE TABLE chunk_embeddings (
    chunk_id TEXT NOT NULL REFERENCES source_chunks(id) ON DELETE CASCADE,
    model TEXT NOT NULL,
    dims INTEGER NOT NULL,
    vector BLOB NOT NULL,
    text_sha TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (chunk_id, model)
  );
  CREATE INDEX chunk_embeddings_model ON chunk_embeddings (model, text_sha);
  `,
  // 12: CI-imported tests record a framework ('JUnit XML' when the delivery did not say one), so the
  //     framework breakdown never counts automated tests as manual (R10).
  `
  UPDATE test_cases SET framework = 'JUnit XML' WHERE kind = 'automated' AND origin = 'ci_results' AND framework IS NULL;
  `,
  // 13: passages carry the hash of their text, so a vector is used or kept only while it matches the
  //     text it was computed from (F25; the server fills it in for existing rows at the next embedding
  //     pass). Approvals left pending by the version-7 upgrade with an empty frozen payload can never
  //     execute; they are expired with the reason instead of waiting forever (F27).
  `
  ALTER TABLE source_chunks ADD COLUMN text_sha TEXT;
  UPDATE approvals SET status = 'expired', outcome = '{"ok":false,"text":"Expired on upgrade: this approval predates frozen payloads. Analyse the story again for a current proposal."}'
    WHERE status = 'pending' AND action = 'add_uat_cases' AND (payload IS NULL OR payload = '{}');
  `,
  // 14: requirement identity is scoped to the application (F23). A requirement row is
  //     "<application>/<external id>", unique per application and external id; story links point at
  //     that row, so FR-0231 in two applications never shares a record. Existing links are re-created
  //     under each story's own application. Triggers refuse any relationship that would join two
  //     applications: a story and a requirement or component, a chat and a workspace, a run and a test,
  //     a test and a story or criterion or component (the brief's tenant-relationship hardening).
  `
  CREATE TABLE requirements_v14 (
    uid TEXT PRIMARY KEY,
    application_id TEXT NOT NULL REFERENCES applications(id),
    external_id TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    source_id TEXT,
    UNIQUE (application_id, external_id)
  );
  INSERT OR IGNORE INTO requirements_v14 (uid, application_id, external_id, title, source_id)
    SELECT r.application_id || '/' || r.id, r.application_id, r.id, r.title, r.source_id FROM requirements r;
  INSERT OR IGNORE INTO requirements_v14 (uid, application_id, external_id)
    SELECT s.application_id || '/' || sr.requirement_id, s.application_id, sr.requirement_id FROM story_requirements sr JOIN stories s ON s.key = sr.story_key;
  CREATE TABLE story_requirements_v14 (
    story_key TEXT NOT NULL REFERENCES stories(key) ON DELETE CASCADE,
    requirement_uid TEXT NOT NULL REFERENCES requirements_v14(uid),
    PRIMARY KEY (story_key, requirement_uid)
  );
  INSERT OR IGNORE INTO story_requirements_v14 (story_key, requirement_uid)
    SELECT sr.story_key, s.application_id || '/' || sr.requirement_id FROM story_requirements sr JOIN stories s ON s.key = sr.story_key;
  DROP TABLE story_requirements;
  DROP TABLE requirements;
  ALTER TABLE requirements_v14 RENAME TO requirements;
  ALTER TABLE story_requirements_v14 RENAME TO story_requirements;

  CREATE TRIGGER story_requirements_same_app BEFORE INSERT ON story_requirements
  BEGIN
    SELECT RAISE(ABORT, 'The requirement belongs to another application than the story.')
    WHERE (SELECT application_id FROM stories WHERE key = NEW.story_key) IS NOT (SELECT application_id FROM requirements WHERE uid = NEW.requirement_uid);
  END;
  CREATE TRIGGER story_components_same_app BEFORE INSERT ON story_components
  BEGIN
    SELECT RAISE(ABORT, 'The component belongs to another application than the story.')
    WHERE (SELECT application_id FROM stories WHERE key = NEW.story_key) IS NOT (SELECT application_id FROM components WHERE id = NEW.component_id);
  END;
  CREATE TRIGGER chats_workspace_same_app BEFORE INSERT ON chats
  BEGIN
    SELECT RAISE(ABORT, 'The workspace belongs to another application than the chat.')
    WHERE NEW.workspace_id IS NOT NULL AND (SELECT application_id FROM workspaces WHERE id = NEW.workspace_id) IS NOT NEW.application_id;
  END;
  CREATE TRIGGER chats_workspace_same_app_update BEFORE UPDATE OF workspace_id ON chats
  BEGIN
    SELECT RAISE(ABORT, 'The workspace belongs to another application than the chat.')
    WHERE NEW.workspace_id IS NOT NULL AND (SELECT application_id FROM workspaces WHERE id = NEW.workspace_id) IS NOT NEW.application_id;
  END;
  CREATE TRIGGER test_results_same_app BEFORE INSERT ON test_results
  BEGIN
    SELECT RAISE(ABORT, 'The test belongs to another application than the run.')
    WHERE (SELECT application_id FROM test_runs WHERE id = NEW.run_id) IS NOT (SELECT application_id FROM test_cases WHERE id = NEW.test_case_id);
  END;
  CREATE TRIGGER test_case_links_same_app BEFORE INSERT ON test_case_links
  BEGIN
    SELECT RAISE(ABORT, 'The story belongs to another application than the test.')
    WHERE NEW.entity_type IN ('story', 'criterion')
      AND (SELECT application_id FROM stories WHERE key = CASE WHEN instr(NEW.entity_ref, '#') > 0 THEN substr(NEW.entity_ref, 1, instr(NEW.entity_ref, '#') - 1) ELSE NEW.entity_ref END) IS NOT NULL
      AND (SELECT application_id FROM stories WHERE key = CASE WHEN instr(NEW.entity_ref, '#') > 0 THEN substr(NEW.entity_ref, 1, instr(NEW.entity_ref, '#') - 1) ELSE NEW.entity_ref END)
          != (SELECT application_id FROM test_cases WHERE id = NEW.test_case_id);
    SELECT RAISE(ABORT, 'The component belongs to another application than the test.')
    WHERE NEW.entity_type = 'component' AND instr(NEW.entity_ref, '/') > 0
      AND substr(NEW.entity_ref, 1, instr(NEW.entity_ref, '/') - 1) != (SELECT application_id FROM test_cases WHERE id = NEW.test_case_id);
  END;
  `,
  // 15: passages are immutable history (F20). A re-index retires the current passages (retired_at)
  //     and writes the new version under new ids ("<source>@v<version>#<seq>") instead of deleting and
  //     reusing ids, so a citation saved with an answer keeps opening the exact text it cited while
  //     retrieval only sees current passages.
  `
  ALTER TABLE source_chunks ADD COLUMN retired_at TEXT;
  CREATE INDEX source_chunks_current ON source_chunks (source_id, retired_at);
  `,
  // 16: indexes behind the predicates the hardening review found scanning: the runs of one commit
  //     (F06), scan and upload histories per application, saved UAT reports by kind, model calls by
  //     run (usage) and ratings by time (feedback patterns).
  `
  CREATE INDEX IF NOT EXISTS test_runs_commit ON test_runs (application_id, repo, sha);
  CREATE INDEX IF NOT EXISTS repo_scans_app ON repo_scans (application_id, started_at);
  CREATE INDEX IF NOT EXISTS hexa_uploads_app ON hexa_uploads (application_id, uploaded_at);
  CREATE INDEX IF NOT EXISTS artifacts_kind ON artifacts (kind, created_at);
  CREATE INDEX IF NOT EXISTS model_calls_run ON model_calls (workflow_run_id);
  CREATE INDEX IF NOT EXISTS ratings_created ON ratings (created_at);
  `,
  // 17: bounded retrieval (F24). A full-text index over passages (external content, porter stemming)
  //     gives the lexical candidates in SQL, so a question no longer loads every passage of the
  //     application. Triggers keep it in step with source_chunks; the server rebuilds it at start when
  //     the counts disagree (rowids of a text-keyed table can move under VACUUM).
  `
  CREATE VIRTUAL TABLE source_chunks_fts USING fts5(text, locator, content='source_chunks', content_rowid='rowid', tokenize='porter unicode61');
  INSERT INTO source_chunks_fts(source_chunks_fts) VALUES ('rebuild');
  CREATE TRIGGER source_chunks_fts_ai AFTER INSERT ON source_chunks BEGIN
    INSERT INTO source_chunks_fts(rowid, text, locator) VALUES (new.rowid, new.text, new.locator);
  END;
  CREATE TRIGGER source_chunks_fts_ad AFTER DELETE ON source_chunks BEGIN
    INSERT INTO source_chunks_fts(source_chunks_fts, rowid, text, locator) VALUES ('delete', old.rowid, old.text, old.locator);
  END;
  CREATE TRIGGER source_chunks_fts_au AFTER UPDATE OF text, locator ON source_chunks BEGIN
    INSERT INTO source_chunks_fts(source_chunks_fts, rowid, text, locator) VALUES ('delete', old.rowid, old.text, old.locator);
    INSERT INTO source_chunks_fts(rowid, text, locator) VALUES (new.rowid, new.text, new.locator);
  END;
  `,
];
