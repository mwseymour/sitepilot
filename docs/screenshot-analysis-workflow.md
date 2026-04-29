# Screenshot Analysis Workflow

## Purpose

This document describes the current screenshot-to-WordPress page workflow in SitePilot.

The feature is intended for requests like:

- "Build a page in WordPress as close to this as you can"
- "Use this mockup as the layout reference"
- "Recreate this design with core blocks"

The goal is not direct screenshot-to-HTML generation. The goal is:

1. accept operator-uploaded reference images
2. analyze them into a structured review artifact
3. require operator review
4. feed the reviewed structure into Gutenberg planning
5. keep execution constrained to the supported core blocks

## Current Product Behavior

The operator workflow is:

1. Upload one or more `.jpg` / `.png` files to a Request in chat.
2. If the request text clearly looks like a screenshot/mockup-driven build, SitePilot marks screenshot analysis as required before planning.
3. The operator clicks `Analyze reference`.
4. SitePilot sends the uploaded image plus a strict schema to OpenAI and receives a structured layout manifest.
5. SitePilot persists that manifest locally and shows it in the Request panel.
6. The operator reviews it and clicks `Approve analysis`.
7. Only after a current reviewed analysis exists can the operator generate an action plan.
8. The planner consumes that reviewed analysis as the structural scaffold for Gutenberg block generation.

If the request text changes after analysis, the analysis becomes stale and must be regenerated and re-approved.

## Tech Stack

Current stack:

- React renderer upload and review UI
- Electron IPC for privileged actions
- Electron main-process service for screenshot analysis
- OpenAI image input + Structured Outputs for the layout manifest
- shared Zod contracts for the manifest schema
- local SQLite persistence for the reviewed artifact
- normal Gutenberg planning after review

This is a model-driven analysis pass, not a computer-vision preprocessing pipeline.

Current non-goals:

- no OmniParser integration
- no separate OCR package
- no screenshot-to-code package
- no DOM reconstruction from pixels

## OpenAI Usage

The current implementation uses OpenAI image input with schema-constrained output.

It follows the Structured Outputs pattern documented here:

- [OpenAI Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs)

In implementation terms:

- the desktop app sends uploaded screenshots as image inputs
- the request includes a strict JSON schema for the expected manifest
- the model returns structured JSON instead of freeform prose
- SitePilot validates and persists that JSON before planning

The current code uses the `chat.completions` request shape with `response_format: { type: "json_schema" }`, not the newer `responses` endpoint yet.

## Main Components

### Renderer

Relevant files:

- `apps/desktop/src/renderer/pages/site/ChatPage.tsx`
- `apps/desktop/src/renderer/styles.css`

Responsibilities:

- image upload through the existing Request attachment flow
- reference-analysis status UI
- `Analyze reference` action
- `Approve analysis` action
- plan-generation gating in the Request panel
- operator review of regions, suggested blocks, and mapping warnings

### IPC and preload

Relevant files:

- `packages/contracts/src/ipc.ts`
- `apps/desktop/src/preload/index.ts`
- `apps/desktop/src/main/ipc.ts`

Responsibilities:

- typed request/response schemas for screenshot analysis
- preload bridge methods
- main-process IPC handlers

Current IPC calls:

- `planner.analyzeRequestVisualAnalysis`
- `planner.reviewRequestVisualAnalysis`

### Main-process screenshot analysis service

Relevant file:

- `apps/desktop/src/main/request-visual-analysis-service.ts`

Responsibilities:

- load request and attachment context
- require an OpenAI API key
- send screenshots plus schema to OpenAI
- normalize and validate the returned manifest
- persist the result
- mark the analysis as reviewed

### Shared contracts

Relevant file:

- `packages/contracts/src/schemas.ts`

Responsibilities:

- define the request visual analysis schema
- define regions and supported payload shape
- make the same structure available to renderer and main process

### Persistence

Relevant files:

- `packages/repositories/src/migrations.ts`
- `packages/repositories/src/interfaces.ts`
- `packages/repositories/src/sqlite-repositories.ts`

Responsibilities:

- create the `request_visual_analyses` table
- persist one request-scoped analysis artifact per request
- retrieve it for bundle loading and planning

### Request bundle and planning gate

Relevant files:

- `apps/desktop/src/main/request-bundle-service.ts`
- `apps/desktop/src/main/plan-generation-service.ts`
- `packages/services/src/request-visual-analysis.ts`

Responsibilities:

- expose the persisted analysis in the Request bundle
- determine whether screenshot analysis is required
- determine whether the analysis is current and reviewed
- block plan generation until those conditions are met

## Persisted Manifest Shape

The analysis artifact stores:

- overall summary
- page type
- layout pattern
- style notes
- responsive notes
- ordered top-to-bottom regions
- suggested Gutenberg block mappings per region
- mapping warnings
- provider/model metadata
- request timestamp used for staleness checks
- review timestamp

Each region includes:

- label
- kind
- layout
- position
- content summary
- suggested blocks
- emphasis
- confidence

This is intentionally a review artifact, not executable content.

## Planning Integration

Relevant file:

- `packages/services/src/generate-action-plan.ts`

When a current reviewed analysis exists:

- the manifest is passed into the planner payload
- the planner is told to treat it as the primary structural scaffold
- the planner still must obey SitePilot's supported Gutenberg block constraints

This means the screenshot analysis does not replace the planner. It narrows and structures the planner's job.

## Gutenberg Constraints

Screenshot analysis does not bypass Gutenberg safety rules.

The planner and execution path are still constrained by:

- supported parsed block names
- plugin-side parsed block validation
- plugin-side canonicalization and serialization rules

See:

- [docs/reliable-gutenberg-blocks.md](/Users/mattseymour/Desktop/ai-dev/sitepilot/docs/reliable-gutenberg-blocks.md)

If the screenshot implies unsupported effects or blocks, the manifest should preserve the design intent in `mappingWarnings` rather than pretending the block support exists.

## Staleness Rules

The analysis is considered current only when:

1. an analysis exists
2. it was generated against the latest `request.updatedAt`
3. it has been approved by the operator

If the operator edits the request after analysis:

- the analysis becomes stale
- the UI shows that it must be re-run
- plan generation is blocked until it is current again

## Why Review Happens Before Planning

The review step exists for safety and control.

Without review:

- the screenshot interpretation is opaque
- the planner can overcommit to a wrong structure
- debugging "why did it build this layout?" becomes harder

With review:

- the operator can inspect the proposed structural interpretation
- the planner gets a narrower, more auditable scaffold
- the analysis artifact can be debugged independently from the action plan

## Known Limits

Current limits:

- only requests that look screenshot/mockup-driven are gated
- analysis is model-driven and may miss subtle layout details
- no independent OCR or geometric parser is used
- only supported Gutenberg core blocks can be planned for execution
- the feature currently depends on OpenAI being configured
- the implementation uses `chat.completions` plus Structured Outputs, not the `responses` API

## Future Upgrade Paths

Plausible future improvements:

- move the analysis call to the OpenAI `responses` API
- add a secondary parser such as OmniParser before the LLM step
- add visual diff / QA after page generation
- add explicit operator edits to the manifest before approval
- add confidence thresholds that trigger mandatory clarification

## Code Map

Primary files:

- `apps/desktop/src/main/request-visual-analysis-service.ts`
- `apps/desktop/src/main/request-bundle-service.ts`
- `apps/desktop/src/main/plan-generation-service.ts`
- `apps/desktop/src/renderer/pages/site/ChatPage.tsx`
- `packages/contracts/src/ipc.ts`
- `packages/contracts/src/schemas.ts`
- `packages/repositories/src/migrations.ts`
- `packages/repositories/src/sqlite-repositories.ts`
- `packages/services/src/request-visual-analysis.ts`
- `packages/services/src/generate-action-plan.ts`
