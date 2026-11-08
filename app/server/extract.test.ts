/**
 * Content extraction for App Context: clean text, sections with headings, kinds, build summaries,
 * capped history, no duplicates, a card per repository, and retrieval that uses the kinds.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { listChunks, retrieveContext, seedContext, testQuestion } from './context';
import { buildSummary, cleanMarkdown, documentPassages, extractPassages, kindPrior, repositoryCard } from './extract';
import { fixtureWithDocs } from './fixture';

const README = `<!-- <p align="center"><img src="/logo.svg" width="300" /></p> -->
<p align="center">
<img src="docs/logo.png" alt="logo">
</p>

[![CI](https://github.com/x/y/actions/workflows/ci.yml/badge.svg)](https://github.com/x/y/actions) [![Go Report](https://goreportcard.com/badge/x)](https://goreportcard.com/report/x)

# Online Boutique

**Online Boutique** is a cloud-first microservices demo application: a web-based e-commerce app where users browse items, add them to the cart and purchase them.

## Table of contents

- [Architecture](#architecture)
- [Quickstart](#quickstart)
- [Development](#development)

## Architecture

Online Boutique is composed of 11 microservices written in different languages that talk to each other over gRPC.

## Quickstart

1. Clone the repository.
2. Run \`skaffold run\` against a Kubernetes cluster.
`;

describe('cleaning and sections', () => {
  it('drops comments, logos, badges and HTML wrappers but keeps the words', () => {
    const { text } = cleanMarkdown(README);
    expect(text).not.toMatch(/<!--|logo\.png|badge\.svg|<p align/);
    expect(text).toContain('**Online Boutique** is a cloud-first microservices demo');
  });

  it('splits by section, carries the heading path, marks the opening as overview and skips the table of contents', () => {
    const ps = documentPassages('README.md', README);
    // The short opening and the Architecture section are both overview, so they are joined, each with its heading.
    expect(ps.map((p) => p.kind)).toEqual(['overview', 'guide']);
    expect(ps[0].text.startsWith('# Online Boutique\n**Online Boutique** is a cloud-first')).toBe(true);
    expect(ps[0].text).toContain('## Online Boutique › Architecture\nOnline Boutique is composed of 11 microservices');
    expect(ps.map((p) => p.text).join('\n')).not.toContain('[Quickstart](#quickstart)');
    expect(ps[1].text).toContain('## Online Boutique › Quickstart');
  });

  it('reads front matter titles, reST underlines and never splits a code fence', () => {
    const jekyll = documentPassages('docs/flatten.md', '---\nlayout: page\ntitle: Flatten batches\n---\n\nFlattening merges batches with the same header into one batch, which reduces file size.\n');
    expect(jekyll[0].text.startsWith('# Flatten batches\n')).toBe(true);
    expect(jekyll[0].text).not.toContain('layout: page');
    const rst = documentPassages('docs/guide.rst', 'Install\n=======\n\nRun the installer with the default options to set up the service.\n');
    expect(rst[0].text).toBe('# Install\nRun the installer with the default options to set up the service.');
    const code = documentPassages('README.md', `## Run\n\nStart it like this, with a local cluster ready:\n\n\`\`\`sh\n# not a heading\nkubectl apply -f ./release\n\`\`\`\n`);
    expect(code).toHaveLength(1);
    expect(code[0].text).toContain('# not a heading\nkubectl apply');
  });

  it('keeps only the newest history entries and drops duplicate text', () => {
    const changelog = Array.from({ length: 60 }, (_, i) => `## v1.${60 - i}.0\n\nFixed issue number ${i} in the batch writer and improved its validation messages. ${'Details of the change, the affected record types and the migration notes for users of the library. '.repeat(8)}`).join('\n\n');
    const ps = extractPassages([{ path: 'CHANGELOG.md', text: changelog }, { path: 'README.md', text: README }, { path: 'docs/a.md', text: '# Services\n\nEach service owns its data and talks to the others only over gRPC, never through a shared database.' }, { path: 'docs/copy-of-a.md', text: '# Services (copy)\n\nEach service owns its data and talks to the others only over gRPC, never through a shared database.' }]);
    const history = ps.filter((p) => p.kind === 'history');
    expect(history.length).toBe(25);
    expect(history[0].text).toContain('v1.60.0');
    expect(history.map((p) => p.text).join('\n')).not.toContain('v1.1.0');
    // History comes after documentation.
    expect(ps.findIndex((p) => p.kind === 'history')).toBeGreaterThan(ps.findIndex((p) => p.kind === 'guide'));
    // The same text under another heading in another file is kept once.
    expect(ps.filter((p) => p.text.includes('never through a shared database'))).toHaveLength(1);
  });
});

describe('build and CI summaries', () => {
  it('summarises compose services and ports, package scripts, Maven modules, workflows and Dockerfiles', () => {
    const compose = buildSummary('docker-compose.yml', `version: '3'\nservices:\n  gateway:\n    image: sqshq/piggymetrics-gateway\n    ports:\n      - "80:4000"\n    depends_on:\n      config:\n        condition: service_healthy\n  rabbitmq:\n    image: rabbitmq:3-management\n    ports:\n      - 15672:15672\n`)!;
    expect(compose).toContain('Defines 2 services:');
    expect(compose).toContain('- gateway (image sqshq/piggymetrics-gateway), ports 80:4000, depends on config');
    expect(compose).toContain('- rabbitmq (image rabbitmq:3-management), ports 15672:15672');
    const pkg = buildSummary('package.json', JSON.stringify({ name: 'ghostfolio', description: 'Wealth management', scripts: { test: 'nx test', start: 'nx serve' }, dependencies: { '@nestjs/core': '1', prisma: '1' } }))!;
    expect(pkg).toContain('Package ghostfolio: Wealth management.');
    expect(pkg).toContain('Tests run with: nx test');
    const pom = buildSummary('pom.xml', '<project><parent><artifactId>spring-boot-starter-parent</artifactId><version>2.0.3.RELEASE</version></parent><artifactId>piggymetrics</artifactId><packaging>pom</packaging><properties><java.version>1.8</java.version></properties><modules><module>gateway</module><module>account-service</module></modules></project>')!;
    expect(pom).toContain('Maven project piggymetrics, packaging pom.');
    expect(pom).toContain('Parent: spring-boot-starter-parent 2.0.3.RELEASE.');
    expect(pom).toContain('Java version 1.8.');
    expect(pom).toContain('Modules: gateway, account-service.');
    const wf = buildSummary('.github/workflows/ci.yml', 'name: CI\non:\n  push:\n  pull_request:\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n      - run: go test ./...\n')!;
    expect(wf).toContain('CI workflow "CI", triggered on push, pull_request.');
    expect(wf).toContain('Jobs: test.');
    expect(wf).toContain('Commands: go test ./....');
    expect(buildSummary('api/Dockerfile', 'FROM golang:1.22 AS build\nRUN go build\nFROM gcr.io/distroless/base\nEXPOSE 8080\nENTRYPOINT ["/app"]\n')).toContain('Base images (multi-stage): golang:1.22 AS build, gcr.io/distroless/base.\nExposes 8080.');
  });

  it('puts the summary first, keeps a few raw passages, and drops licence headers', () => {
    const header = '# Copyright 2026 Google LLC\n#\n# Licensed under the Apache License, Version 2.0\n\n';
    const ps = extractPassages([{ path: '.github/workflows/release.yml', text: `${header}name: Release\non: [push]\njobs:\n  release:\n    runs-on: ubuntu-latest\n${'    # padding line to make the file long\n'.repeat(200)}`, build: true }]);
    expect(ps[0]).toMatchObject({ locator: '.github/workflows/release.yml · summary', kind: 'ci' });
    expect(ps.filter((p) => p.locator.includes('¶')).length).toBeLessThanOrEqual(4);
    expect(ps.map((p) => p.text).join('\n')).not.toContain('Licensed under the Apache');
  });
});

describe('repository card and retrieval', () => {
  it('a card says what the repository is, what it is built with and which components live in it', () => {
    const card = repositoryCard({ name: 'microservices-demo', github: 'GoogleCloudPlatform/microservices-demo', languages: ['Go', 'C#'], testFrameworks: ['go test'], components: [{ name: 'frontend', path: 'src/frontend', manager: 'Sourav' }] }, [{ path: 'README.md', text: README }]);
    expect(card).toMatchObject({ locator: 'Overview', kind: 'overview' });
    expect(card.text).toContain('# Repository microservices-demo (overview)');
    expect(card.text).toContain('Components of this application in it: frontend (src/frontend), managed by Sourav.');
    expect(card.text).toContain('cloud-first microservices demo application');
  });

  it('"what is this repo about" finds the overview first, not a release script or a workflow', async () => {
    const { db, ws, cloneDir } = fixtureWithDocs();
    mkdirSync(join(cloneDir, 'docs', 'releasing'), { recursive: true });
    writeFileSync(join(cloneDir, 'docs', 'releasing', 'README.md'), '# Releasing\n\n```sh\n# assuming you are inside the root path of the shop repository\nexport TAG=vX.Y.Z\n./make-release.sh\n```\n\nThis creates a release of the repo and a pull request.\n');
    mkdirSync(join(cloneDir, '.github', 'workflows'), { recursive: true });
    writeFileSync(join(cloneDir, '.github', 'workflows', 'release.yml'), 'name: Release\non: [push]\njobs:\n  release:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n        with:\n          repo: shop\n');
    seedContext(db, ws);
    const r = await retrieveContext(db, 'ABCD', 'what is this repo about ?', { minRelevance: 0.01 });
    expect(r.passages[0].sourceTitle).toBe('shop');
    expect(r.passages[0].locator).toBe('Overview');
    const t = await testQuestion(db, db.getApp('ABCD')!, 'what is this repo about ?');
    expect(t.results[0].where).toMatch(/shop · (Overview|README\.md ¶1)/);
    // A question about CI still reaches the workflow summary.
    const ci = await retrieveContext(db, 'ABCD', 'which GitHub Actions workflow builds the release?', { minRelevance: 0.01 });
    expect(ci.passages.some((p) => p.locator === '.github/workflows/release.yml · summary')).toBe(true);
    expect(listChunks(db, 'ABCD', 'ABCD-repo-shop').find((c) => c.locator === '.github/workflows/release.yml · summary')?.kind).toBe('ci');
  });

  it('kind priors: manifests and history give way unless asked about', () => {
    expect(kindPrior('build', 'What is the refund window?')).toBeLessThan(1);
    expect(kindPrior('build', 'Which docker image and ports does the gateway use?')).toBeGreaterThan(1);
    expect(kindPrior('history', 'What changed in version 1.68?')).toBeGreaterThan(1);
    expect(kindPrior('history', 'How are batches numbered?')).toBeLessThan(1);
    expect(kindPrior('overview', 'What is this repository about?')).toBeGreaterThan(1);
    expect(kindPrior(null, 'anything')).toBe(1);
  });
});
