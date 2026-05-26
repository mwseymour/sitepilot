# Automated Local Testing Specification

## Purpose

SitePilot needs a repeatable local test loop that exercises the same workflow an
operator currently tests by hand:

1. start from a known WordPress site state;
2. create a real SitePilot chat request;
3. generate and approve an action plan;
4. execute the plan through the WordPress companion plugin;
5. open the created or updated WordPress post/page;
6. verify the rendered and editor-visible output.

Unit and integration tests remain necessary, but they do not catch the full class
of regressions that happen when planner output, MCP mapping, plugin-side block
serialization, WordPress persistence, and Gutenberg rendering meet in a real site.
This document specifies the missing automated local regression layer.

## Current Problem

Local development currently relies on:

- TypeScript unit/integration tests via `npm run test`;
- static checks via `npm run typecheck`, `npm run lint`, and `npm run format`;
- plugin PHPUnit tests via `composer test` in `plugins/wordpress-sitepilot`;
- manual live WordPress checks after planner or execution changes.

The manual loop is too slow and easy to misread. Recent regressions have involved
successful-looking executions that wrote malformed or unexpected Gutenberg
content, or humans checking the wrong post after a chat follow-up. The automation
must test the product behavior, not just isolated functions.

## Goals

- Run a local end-to-end regression from one command.
- Use the same SitePilot chat/request/execution path that the desktop app uses.
- Create real WordPress drafts through the companion plugin.
- Verify the post/page output in both persisted content and browser-rendered
  views.
- Capture screenshots, execution payloads, post IDs, and diffs as artifacts.
- Make failures obvious enough that Codex or another coding agent can iterate
  without relying on a human to manually inspect wp-admin after every change.
- Keep the harness deterministic enough for local development while allowing
  model-backed scenarios to run when provider credentials are available.

## Non-goals

- Replacing unit, integration, or PHPUnit coverage.
- Proving every WordPress theme or plugin combination.
- Running against production sites.
- Testing unrestricted WordPress administration.
- Generating pixel-perfect design comparisons for arbitrary pages in the first
  version.
- Depending on a hosted SitePilot service.

## Recommended Test Layers

### Layer 1: Existing fast checks

These stay as the default pre-flight checks:

```sh
npm run typecheck
npm run lint
npm run test
npm run format
cd plugins/wordpress-sitepilot && composer test
```

They should continue to cover contracts, planner normalization, MCP action
mapping, repository behavior, and plugin write validation.

### Layer 2: Local WordPress smoke environment

Add a disposable local WordPress environment for end-to-end tests.

Recommended shape:

- Docker Compose or `wp-env` based WordPress instance;
- known WordPress version compatible with the plugin;
- known PHP version compatible with the plugin;
- bundled SitePilot companion plugin mounted from this repository;
- deterministic theme, preferably a core block theme;
- known admin user with application password or test-only signed SitePilot
  registration;
- resettable database and media uploads between runs.

The harness must be able to reset to a clean baseline without manual wp-admin
work.

### Layer 3: Headless SitePilot scenario runner

Add a Node-based scenario runner that drives the real main-process service layer
without needing a human to operate the Electron renderer.

Responsibilities:

- create or load a test workspace;
- register the local WordPress site;
- run diagnostics and discovery;
- create or activate a minimal site config;
- create a chat thread;
- create one or more requests;
- generate plans;
- apply approval decisions;
- execute through the same MCP/action mapping path used by the app;
- persist audit and execution records;
- print a machine-readable summary containing request IDs, execution IDs, MCP
  tool calls, post IDs, and URLs.

The runner should avoid special execution shortcuts. A test-only fixture setup is
acceptable, but the actual request-to-execution path should match production code.
For approvals, the suite should cover both paths explicitly:

- one named scenario must exercise the real approval workflow end to end,
  including creation of a pending approval and an explicit approval decision;
- all other baseline scenarios should run with a test-site configuration that
  bypasses approval so the suite stays fast and deterministic;
- the report must state whether each scenario used the real approval path or the
  bypassed path.

### Layer 4: Browser verification

Use Playwright or an equivalent browser runner to inspect WordPress after
execution.

Minimum browser checks:

- open the front-end preview URL for draft content;
- open the public permalink only for published or otherwise publicly reachable
  fixtures;
- open the block editor through a dedicated authenticated wp-admin browser
  session fixture;
- assert expected text, headings, images, and layout-significant wrappers are
  present;
- assert broken-image indicators are absent for scenarios involving media;
- assert Gutenberg invalid-block recovery UI is not present in the editor;
- capture screenshots on success and failure;
- save the final HTML and relevant editor DOM snippets as artifacts.

Visual checks should start with structural assertions and screenshots. Pixel
threshold comparisons can be added later for stable fixture pages.

## First Scenario Set

The first automated suite should cover the workflows that currently cause the
most manual retesting.

### Scenario A: Create a simple draft post

Prompt:

```text
Create a draft post called Automated Test Post with three short paragraphs about
first-time buyer mortgage advice.
```

Expected checks:

- one draft post is created;
- title matches the request;
- title begins with a generated test prefix in the format
  `AUTOMATED-TEST-HHMM-DDMMYYYY`, where `HHMM` and `DDMMYYYY` are replaced with
  the actual local test-run time and date;
- front-end or preview contains all paragraph text;
- `post_content` contains valid block markup;
- no Classic block fallback is created;
- audit log records request, plan, execution, and result.

### Scenario B: Create a designed Gutenberg page

Prompt:

```text
Create a draft page called Automated Test Landing Page with a hero section, two
columns, a short services section, and a call to action.
```

Expected checks:

- one draft page is created;
- title begins with a generated test prefix in the format
  `AUTOMATED-TEST-HHMM-DDMMYYYY`, where `HHMM` and `DDMMYYYY` are replaced with
  the actual local test-run time and date;
- output contains expected heading hierarchy;
- columns render as Gutenberg columns, not escaped comments or raw text;
- CTA text appears once;
- editor opens without invalid block warnings;
- serialized content contains supported core block names.

### Scenario C: Follow-up block insertion

Starting point:

- use the post from Scenario A.

Prompt:

```text
Add an H2 heading after paragraph 2 that says Common mistakes to avoid.
```

Expected checks:

- only the targeted post is updated;
- the new heading appears after the second paragraph;
- original paragraphs remain present and in order;
- planner and MCP payloads target a narrow block insertion, not a full rewrite;
- no escaped Gutenberg delimiters appear in text-like block HTML.

### Scenario D: Follow-up media insertion

Starting point:

- use the post from Scenario C;
- provide a known local image fixture.

Prompt:

```text
Add this image after the new heading with helpful alt text.
```

Expected checks:

- media is uploaded to the WordPress Media Library;
- image block references a site-local attachment URL and ID;
- alt text is present;
- front-end image loads with a successful response;
- surrounding content order is preserved.

### Scenario E: Heading level edit

Starting point:

- use the post from Scenario D.

Prompt:

```text
Change the Common mistakes to avoid heading from H2 to H3.
```

Expected checks:

- the heading changes to `h3`;
- adjacent image and paragraphs remain unchanged;
- execution does not rewrite the whole post body;
- audit records the previous and updated state where available.

## Ad Hoc Prompt Replay

The fixed scenarios above are the baseline regression suite. They are the tests
that should run repeatedly to catch known failure patterns. Local development also
needs an ad hoc replay path for whatever the developer or coding agent is testing
right now.

If a local SitePilot chat request fails, the developer should not need to turn it
into a formal scenario before debugging. They should be able to copy the exact
chat request text and ask Codex or another agent to replay it through the same
end-to-end harness.

Suggested command shapes:

```sh
npm run test:e2e -- --prompt "Create a landing page for X with a hero, two columns and CTA"
npm run test:e2e:replay -- --request-file ./tmp/my-failed-request.txt
```

The replay flow should:

1. accept the pasted prompt or request file;
2. reset or select the configured local WordPress test site;
3. create a real SitePilot chat request with that text;
4. run the normal planning, approval, and execution path;
5. open the resulting post/page with the browser runner;
6. assert the default structural and rendering checks that apply to the result;
7. save the same artifacts as named scenarios: plan JSON, normalized plan, MCP
   input/output, final `post_content`, screenshots, DOM snapshots, and report;
8. let the AI agent inspect those artifacts, fix the failure, and rerun the same
   prompt.

The distinction should be:

- formal scenario: a named test worth keeping because it protects a known
  workflow or regression;
- ad hoc prompt: a quick reproduction for the request currently being developed
  or debugged;
- promotion: when an ad hoc prompt exposes a real bug, convert it into a named
  scenario after the fix so the regression remains covered.

## Model-backed vs Fixture-backed Runs

The harness should support two modes.

### Fixture-backed mode

Use stored raw planner/model outputs as fixtures while still running the normal
plan normalization, validation, approval, and execution pipeline.

Fixture boundary:

- freeze the raw structured model response that would normally come back from the
  planner;
- do not freeze normalized plans, validation results, approval state, MCP tool
  inputs, or execution outputs;
- always recompute those downstream steps in the harness so fixture-backed runs
  still test planner normalization, policy checks, MCP mapping, plugin writes,
  WordPress persistence, and browser rendering.

Purpose:

- fast local regression;
- stable CI candidate;
- useful when no AI provider key is available;
- verifies mapping, execution, WordPress persistence, and visual rendering.

### Model-backed mode

Use the configured provider and current prompts.

Purpose:

- catches prompt/model drift;
- validates real local development changes;
- useful before merging planner or prompt-related work.

Model-backed runs should store:

- provider name;
- model name;
- prompt payload summary;
- raw structured plan;
- normalized plan;
- validation warnings;
- final MCP tool inputs and outputs.

Failures in model-backed mode should be triaged as either product regressions or
expected model variance. The test report should make that distinction visible.

## Command Shape

The final developer interface should be simple.

Proposed commands:

```sh
npm run test:e2e:setup
npm run test:e2e
npm run test:e2e -- --scenario create-designed-page
npm run test:e2e:model
npm run test:e2e:open-report
```

Expected behavior:

- `test:e2e:setup` starts or resets the local WordPress test site;
- `test:e2e` runs fixture-backed scenarios;
- `test:e2e:model` runs model-backed scenarios and requires provider
  credentials;
- `test:e2e:open-report` opens the latest HTML report and screenshots.

## Artifacts

Every scenario run should write artifacts under an ignored local directory such
as `.sitepilot-test-artifacts/`.

Required artifacts:

- scenario summary JSON;
- request and execution IDs;
- created or updated WordPress object IDs;
- final action plan JSON;
- normalized MCP tool inputs;
- MCP tool outputs;
- final `post_content`;
- front-end HTML snapshot;
- editor DOM snapshot where available;
- screenshots before and after execution where relevant;
- failure trace from the browser runner.

These artifacts are essential for agent-driven debugging. A coding agent should
be able to inspect the artifacts and identify whether the failure happened in
planning, mapping, plugin execution, WordPress persistence, or rendering.

## Local WordPress Requirements

The test site should be intentionally boring.

Baseline requirements:

- clean WordPress install;
- SitePilot companion plugin active;
- REST API reachable;
- MCP endpoint reachable;
- permalinks configured;
- block editor enabled;
- deterministic theme active;
- admin credentials stored only in local environment variables or a test-only
  secrets file ignored by Git;
- uploads directory resettable;
- test-created content titles prefixed using the format
  `AUTOMATED-TEST-HHMM-DDMMYYYY`, with `HHMM` and `DDMMYYYY` replaced by the
  actual local test-run time and date.

The setup must never target a production site. The runner should refuse to run if
the configured base URL is not explicitly marked as a local test environment.

## Safety Rules

- E2E tests must create drafts by default, not publish live content.
- Test-created content must use the title prefix format
  `AUTOMATED-TEST-HHMM-DDMMYYYY`, with `HHMM` and `DDMMYYYY` replaced by the
  actual local test-run time and date.
- Cleanup should delete or trash only content created by the test namespace.
- The runner must print the target WordPress base URL before execution.
- The runner must block execution unless the site has an explicit test marker.
- Application passwords, provider keys, and signing secrets must not be written
  to artifacts.

## Visual Verification Strategy

The first version should prioritize semantic visual checks over brittle snapshots.

Examples:

- assert that `.wp-block-columns` exists for a columns scenario;
- assert that paragraph and heading order matches the prompt;
- assert that images have loaded dimensions and no failed network response;
- assert that the editor does not show invalid block warnings.

Screenshot diffing can be introduced later for fixed fixtures. When introduced,
diff thresholds should be per-scenario and should account for fonts, browser
rendering differences, admin bars, and responsive viewport changes.

## Reporting

The local report should answer five questions quickly:

1. Which prompt ran?
2. Which post/page did it create or update?
3. What plan and MCP calls were produced?
4. What did WordPress persist?
5. What did the browser see?

Recommended report sections:

- scenario status;
- prompt and fixture metadata;
- request, plan, approval, execution, and audit IDs;
- WordPress object links;
- screenshots;
- DOM/assertion failures;
- final `post_content`;
- redacted MCP payloads.

## Implementation Phases

### Phase 1: Harness foundation

- Add local WordPress test environment setup.
- Add ignored artifact directory.
- Add a scenario runner that can register the local test site and create a
  simple request.
- Add a browser runner that can open the created draft/preview URL.

Exit criteria:

- one command creates a draft post through SitePilot and captures a screenshot.

### Phase 2: Core content scenarios

- Implement Scenarios A, B, C, and E.
- Add assertions for post IDs, titles, content order, block markup, and invalid
  editor warnings.
- Emit full run reports.

Exit criteria:

- planner/execution changes can be validated without manual wp-admin checking for
  the core text and layout workflows.

### Phase 3: Media scenario

- Add fixture image upload support.
- Implement Scenario D.
- Verify Media Library upload, image block rewrite, alt text, and front-end image
  loading.

Exit criteria:

- image-related regressions are reproducible locally without manual media setup.

### Phase 4: Model-backed regression mode

- Add provider-backed runs for the same scenario set.
- Store raw and normalized model outputs as artifacts.
- Add clear reporting for model variance vs deterministic product failures.

Exit criteria:

- prompt, planner, and model behavior can be checked before merging changes.

### Phase 5: CI candidate

- Decide whether fixture-backed E2E can run in CI.
- Keep model-backed E2E local/manual unless provider credentials and cost controls
  are explicitly configured.
- Add a small fixture-backed smoke suite to CI if runtime is acceptable.

Exit criteria:

- CI catches basic WordPress execution/rendering regressions, while local
  model-backed tests catch prompt drift.

## Acceptance Criteria

The automated testing work is successful when:

- a developer or coding agent can run one local command after changing planner,
  execution, MCP mapping, or plugin write code;
- the command creates or updates real WordPress content through SitePilot;
- the browser verifies the resulting post/page without manual inspection;
- failures include enough artifacts to locate the broken layer;
- the suite covers create, layout, follow-up insertion, media insertion, and
  narrow block edit workflows;
- no secrets are exposed in reports;
- the local setup cannot accidentally run against production.

## Open Decisions

- Use Docker Compose directly or adopt `wp-env`.
- Drive Electron main-process services directly or expose a dedicated test runner
  entry point.
- Use application passwords, signed SitePilot requests, or both for the local
  test site.
- Whether editor checks require logging into wp-admin or can rely on REST,
  preview, and serialized content for early phases.
- Whether fixture-backed plan responses should live in `tests/fixtures` or a
  dedicated E2E package.
- How much of the model-backed suite should ever run in CI.

## Recommended Starting Point

Start with the smallest valuable loop:

```text
reset local WordPress -> create SitePilot request -> execute draft-post plan ->
open preview URL -> assert title/body/block markup -> save screenshot and payloads
```

Once that loop is reliable, add follow-up edits and media. Those are the workflows
most likely to expose the regressions that unit tests currently miss.
