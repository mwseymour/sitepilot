Product specification
1. Product name

Working title: SitePilot
Alternative internal names: WP Agent Console, WordPress Control Plane, TextOps for WordPress

The name is not part of the technical design.

2. Product summary

SitePilot is a desktop application for managing multiple WordPress sites through natural-language chat, structured requests, and approval-driven automation.

A user connects a WordPress site to the desktop app using a thin companion plugin. Before any chat-based work can begin, the app forces completion of a per-site configuration profile, partially generated automatically by AI from discovered site structure. Once configured, the user can manage content and selected site operations by chatting with the app instead of working directly in wp-admin.

The product is designed for agencies, internal marketing/content teams, and non-technical client users who need to request or approve site changes without being given broad CMS access.

The core product promise is:

safe natural-language changes
site-aware agent behaviour
restricted, structured actions
approval and auditability
multi-site management from one interface

The product is not a general autonomous AI with unrestricted control over WordPress. It is a constrained control plane over defined site capabilities.

3. Problem statement

WordPress clients and junior editors often need to make simple, repetitive, or content-focused changes, but giving them direct wp-admin access creates consistent risk:

pages are broken accidentally
layouts are changed unintentionally
menus and SEO settings are mishandled
media is uploaded inconsistently
custom post types and taxonomies are misused
developers are dragged into low-value content tasks
agencies become bottlenecks for simple changes

At the same time, traditional ticketing and email-driven update workflows are slow, ambiguous, and poorly structured.

The product solves this by introducing a mediated workflow:

the user requests a change in plain language
the system inspects site context and asks clarification questions if required
the system proposes a structured plan
the plan is approved if necessary
the app executes constrained actions against the site
all activity is logged and reversible where possible
4. Product goals
4.1 Primary goals
Allow WordPress content/admin tasks to be requested in natural language
Prevent non-technical users from breaking sites
Centralise management of multiple WordPress sites
Replace low-value content tickets with chat-driven workflows
Preserve developer control through config, permissions, approvals, and tool restrictions
Maintain a full audit trail of requests, decisions, and executed changes
4.2 Secondary goals
Improve quality of content changes through AI suggestions
Standardise editorial workflows across many sites
Surface site structure and rules to the AI explicitly
Enable future integrations through email, Slack, and other channels
Support migration from local desktop to cloud-hosted control plane
4.3 Non-goals
Unrestricted administrative control of WordPress
Automatic theme/plugin development by the AI
Fully autonomous site operation without approval or guardrails
Replacing developers for structural or custom-code work
Editing arbitrary front-end layout systems without site-specific tooling
5. Product principles
5.1 Chat is the interface, structured actions are the product

Users interact conversationally, but the system never executes freeform “do anything” commands. The agent translates intent into known, typed actions.

5.2 Site awareness is mandatory

The agent must behave differently for every site based on its configuration, post types, SEO rules, menus, fields, templates, taxonomy structure, permissions, and guardrails.

5.3 Approval before impact

High-impact or ambiguous actions must pass through preview and approval. Low-risk actions may be auto-approved only when the site config explicitly allows it.

5.4 The site plugin stays thin

The WordPress plugin is a secure execution bridge, not the product brain. Core logic, orchestration, prompts, approvals, and history live in the desktop app.

5.5 Local-first, cloud-ready

The desktop app is the first deployment mode. Internal boundaries must still support future hosted control-plane deployment.

6. Target users
6.1 Agency admin

Manages many sites, defines rules, controls approvals, reviews logs, delegates access.

6.2 Content manager

Requests and approves content changes, publishes drafts, manages taxonomies and media.

6.3 Client requester

Submits update requests in plain English without direct CMS access.

6.4 Site approver

Can review proposed actions and approve or reject them.

6.5 Developer/technical owner

Defines site config, allowed actions, protected areas, and integration settings.

7. Supported deployment modes
7.1 Local desktop mode

Primary product mode for initial release.

Electron application installed on the operator’s machine
local embedded database
one or more connected WordPress sites
local AI provider credentials or workspace credentials
direct connection from desktop app to live WordPress sites
7.2 Future hosted mode

Not the initial deployment, but the architecture will support it.

hosted web control plane
remote authentication
true multi-user collaboration
central billing
shared audit and team workspaces
browser-based approvals and notification flows

The product model must remain identical across both modes.

8. Core user journeys
8.1 Connect a site
User installs the companion plugin on a WordPress site
User opens the desktop app and chooses “Add Site”
App generates registration credentials
User pastes credentials into plugin settings or completes a handshake flow
App validates connectivity and capability compatibility
Site is registered but remains inactive for chat
App runs site discovery
AI drafts a first-pass site config
User reviews and completes required configuration
Site becomes active for chat and actions
8.2 Request a change
User opens a site workspace
User starts a chat or selects an existing thread
User says “Create a page about mortgage advice for first-time buyers”
Agent inspects site context
Agent asks follow-up questions if anything material is missing
Agent builds a structured change plan
Agent presents draft content and target actions
If approvals are required, request enters approval state
On approval, actions execute against the site
App stores results and links them to the chat and audit trail
8.3 Review and approve
Approver opens pending actions
Approver sees summary, field-level changes, affected objects, SEO/meta changes, menu impacts, and publish status
Approver approves, rejects, or requests revision
Execution happens only after approval unless policy permits auto-run
8.4 Roll back or amend
User opens a completed action
App shows what changed
User chooses revert, clone request, or create follow-up edit
App executes supported reversals or drafts a compensating action
9. Product modules
9.1 Workspace dashboard

The desktop home screen showing:

all connected sites
site health/status
pending approvals
recent actions
failed jobs
site connection warnings
model/key status
plugin version compatibility
unread chat activity
9.2 Site workspace

Per-site area containing:

chat threads
site overview
config
content objects
pending actions
approvals
audit history
connection diagnostics
tool permissions
9.3 Chat interface

Features:

per-site chats
pinned context
request status badges
cited site references
action previews inline
diff-style change summaries
structured follow-up questions
quick actions such as approve, reject, publish, revise
9.4 Approval centre

Single place to manage:

pending approval items
rejected actions
revised drafts
expired approvals
high-risk actions awaiting sign-off
9.5 Audit log

Immutable operational history containing:

who requested a change
which site it affected
what the agent planned
which tools were invoked
what values changed
who approved it
execution result
rollback state
9.6 Site configuration

Mandatory site profile with editable sections for:

site identity and context
structure
content types
SEO preferences
menu rules
media rules
tone and style
approval rules
forbidden actions
tool access policy
9.7 Settings

Settings categories:

AI provider keys
default model provider
per-workspace overrides
app profiles
plugin auth management
logging retention
export/import
notification settings
10. Channel model

The product’s primary interface is in-app chat.

Additional ingress channels may be added later:

email
Slack
Teams
webhook/API
browser extension
WordPress dashboard mini-panel

These channels create or append to requests inside the same per-site conversation model. They are not separate workflow systems.

In local desktop mode, external channels are optional add-ons and not a hard dependency.

Functional specification
11. Site connection and onboarding
11.1 Companion plugin requirements

Each connected site installs a companion WordPress plugin that:

registers the site with the desktop app
stores site identifier and authentication material
stores the allowed admin app origin/URL
provides discovery data
exposes approved site capabilities through MCP and/or app-controlled endpoints
verifies signed requests
executes site actions under WordPress capability checks
reports results and errors

The plugin must remain lightweight and avoid storing:

AI provider API keys
chat history
prompt content
long-lived approval workflows
cross-site business logic
11.2 Registration flow

The registration process must establish trust between app and site.

Required data:

site UUID
workspace UUID
trusted app origin/URL
client identifier
signing secret or asymmetric keypair registration
created timestamp
plugin version
protocol version
status

Registration states:

unregistered
pending verification
verified
revoked
rotated
disabled
11.3 Connectivity checks

During onboarding the app must test:

site reachability
plugin availability
auth validity
protocol compatibility
required WordPress version
required PHP version if relevant
required abilities/MCP server availability
tool discovery
permission mapping
11.4 Mandatory configuration gate

A site cannot enter chat-active state until configuration is completed.

Required sections:

site summary
site purpose/business description
primary audience
allowed content types
protected content types
approval defaults
permitted actions
SEO behaviour
menu behaviour
media behaviour

The app may auto-fill these using discovery, but the user must confirm required fields.

12. Site discovery
12.1 Discovery sources

The app gathers structure through approved plugin tools such as:

site info
WordPress version and environment summary
post types
taxonomies
menus
registered image sizes
permalink structure
public pages and key URLs
active SEO plugin info where available
custom fields/ACF groups where integration is enabled
templates or block patterns where safely exposed
user roles/capability summaries
plugin-defined business rules
12.2 Discovery output

Discovery produces a structured site map:

site metadata
content model
taxonomy model
page hierarchy
field schema
media rules
menu schema
publish flow
known limitations
warnings
12.3 AI-generated first-pass config

The app uses discovery output to generate a site profile draft including:

plain-English site summary
inferred editorial rules
inferred post types and intended uses
suggested restricted areas
suggested approval requirements
suggested safe actions
suggested disallowed actions

The user then edits and confirms.

13. Per-site configuration model

Each site has a versioned configuration document.

13.1 Identity and context

Fields:

site name
environment label
base URL
organisation/client name
industry
business description
key products/services
audience summary
brand voice summary
content goals
13.2 Structure

Fields:

public sections of site
page tree summary
primary navigation model
footer/navigation rules
blog/news structure
landing page rules
archive behaviours
known templates
restricted templates
13.3 Content model

Fields:

post types available
which are AI-editable
which are read-only
taxonomy definitions
required fields
optional fields
slug rules
publish states
scheduling policy
13.4 Field model

Fields:

supported meta fields
ACF field groups
validation rules
protected fields
generated fields
computed fields
non-editable technical fields
13.5 SEO policy

Fields:

preferred title patterns
meta description policy
canonical policy
index/noindex rules
internal linking expectations
redirects on slug change
schema/plugin integration notes
13.6 Media policy

Fields:

accepted formats
preferred image ratios
alt text rules
featured image requirements
compression rules
naming conventions
media library restrictions
13.7 Approval policy

Fields:

action risk thresholds
who can approve what
auto-approve categories
draft-only categories
publish restrictions
menu-change restrictions
delete restrictions
13.8 Tool access policy

Fields:

enabled tools
disabled tools
read-only tools
dry-run-only tools
role constraints
environment constraints
13.9 Content style policy

Fields:

tone
reading level
naming conventions
disallowed wording
legal/compliance notes
required CTAs
formatting preferences
13.10 Guardrails

Fields:

never edit these pages
never modify menu automatically
never publish without approval
never delete media
never touch theme settings
never alter redirects without sign-off

The entire site config is versioned and auditable.

14. Chat and request model
14.1 Chat scope

Chats are always scoped to one site. Cross-site chats are not allowed by default.

14.2 Thread types

Thread types:

general request
content creation
content update
media request
SEO request
taxonomy request
publish request
maintenance/diagnostic request
approval discussion
14.3 Request lifecycle

States:

new
clarifying
drafted
awaiting approval
approved
executing
completed
partially completed
failed
reverted
archived
14.4 Clarification engine

The agent must ask follow-up questions when material information is missing. Typical questions include:

which post type
draft or publish
where the page should live
should it appear in the menu
which image should be used
should a featured image be created or chosen
what SEO title/meta should be used
whether internal links should be added
whether similar existing content should be reused

The engine should not ask unnecessary questions where site config or defaults already answer them.

14.5 Similarity and duplication checks

Before creating new content, the agent checks for:

existing similar pages/posts
existing near-duplicate titles
URL conflicts
taxonomy overlap
recent related drafts
redirect collisions

It may recommend updating an existing item instead of creating a new one.

14.6 Content suggestion features

Optional AI assistance within the request flow:

title suggestions
SEO title suggestions
meta description suggestions
excerpt generation
CTA suggestions
internal link suggestions
alternative slugs
image brief generation
15. Action system
15.1 Action philosophy

Every operation the agent performs must map to a typed action with:

inputs
validation
permission requirements
risk classification
dry-run capability where possible
audit output
15.2 Action categories
Content actions
create content item
update content fields
replace content body
append section to content
update excerpt
duplicate item
schedule publish
publish draft
unpublish item
archive item
SEO actions
set SEO title
set meta description
set canonical
set index/noindex
create redirect on slug change
generate internal link suggestions
Taxonomy actions
assign taxonomy term
create taxonomy term
rename term
remove term assignment
Media actions
upload media
attach media
set featured image
generate alt text suggestion
replace image reference
create media brief task
Navigation actions
add item to menu
move menu item
remove menu item
update menu label
Structural actions
create page in hierarchy
move page parent
set template where explicitly allowed
Safe admin actions
view site info
list recent errors exposed by plugin
refresh index/discovery cache
inspect plugin status
inspect capability map
Dangerous actions

These exist only if explicitly enabled:

delete content
bulk update content
modify redirects
modify settings
edit templates
run code-affecting workflows
15.3 Risk classification

Each action has a risk level:

low
medium
high
critical

Risk depends on:

content type
environment
publish status
live visibility
number of affected objects
config rule overrides

Risk determines whether the action may:

execute immediately
execute only as draft
require approval
be blocked entirely
15.4 Dry-run and preview

Where possible, actions should support dry-run mode returning:

intended target objects
proposed field changes
warnings
validation issues
approval recommendation
16. Approval system
16.1 Approval triggers

Approval is required when:

content will be published immediately
a live page is being materially changed
menu/navigation is altered
a slug changes
a redirect is created or modified
SEO metadata changes on key pages
multiple objects are affected
any action is high or critical risk
site policy mandates approval
16.2 Approval payload

An approval item includes:

request summary
site
thread link
proposed actions
object-level diffs
content previews
SEO/meta preview
affected URLs
risk score
rollback notes
agent reasoning summary
execution dependencies
16.3 Approval decisions

Decisions:

approve
reject
request revisions
approve draft-only
defer
16.4 Expiry

Approvals may expire based on config. Expired approvals return the request to drafted state.

17. Audit and reversibility
17.1 Audit requirements

Every request and execution must record:

request text
clarifications asked
user responses
chosen actions
model and prompt versions
tool calls
inputs and outputs
validation outcomes
approvals
execution timestamps
result payloads
rollback status
17.2 Reversible operations

Where possible the system must support explicit revert actions by storing:

original field values
previous taxonomy assignments
previous menu positions
previous publish state
previous slug
previous SEO data

For non-reversible operations, the audit must indicate that reversal requires a compensating action.

18. Search and site understanding

The app must support semantic and structured search across site-discovered content and previous actions.

Capabilities:

find pages by topic
find similar titles
inspect previous approved changes
locate pages using given terms
identify recently updated content
show “what changed last week”
suggest existing content for reuse

This search runs against locally stored site metadata and cached content summaries, not necessarily full live content every time.

Technical implementation specification
19. Architecture overview

The product has four primary layers.

19.1 Desktop UI layer

Electron application UI:

dashboard
site workspace
chats
approvals
config editor
audit views
settings
19.2 Core application layer

Business logic and orchestration:

request parsing
context assembly
clarification engine
plan builder
approval workflow
action executor
audit logger
rule engine
plugin communication manager
site discovery service
19.3 Infrastructure adapter layer

Swappable interfaces for:

database
AI provider
MCP client transport
secrets storage
file storage
notifications
logging
19.4 WordPress site bridge layer

Thin plugin responsible for:

registration and auth verification
site discovery endpoints
action execution
MCP server/tool exposure
capability checks
rollback support where feasible

This separation is what makes future cloud migration practical.

20. Desktop application stack
20.1 Runtime
Electron
Node.js main process
Chromium renderer
20.2 UI

Recommended:

React
TypeScript
state library such as Zustand or Redux Toolkit
component library chosen for dense app UI
local form validation
20.3 IPC boundary

All sensitive logic stays out of the renderer where possible.

Renderer handles:

display
input
interaction state

Main process handles:

secrets
DB access
network to sites
AI provider calls
filesystem access
job orchestration

Communication occurs over a typed IPC layer.

21. Local persistence
21.1 Primary database choice

For desktop distribution, the primary local database should be SQLite, accessed through a repository layer. This is the simplest embedded option for a local Electron app and avoids requiring the user to install and run a database service. MySQL support may exist for development or advanced self-hosted workspace deployments, but SQLite is the product default in local mode.

21.2 Storage categories

The local database stores:

workspaces
users/profiles
sites
site configs
registration credentials metadata
chats
messages
requests
action plans
approvals
audit log entries
tool call records
discovery snapshots
content/cache summaries
settings
provider configuration
sync/export metadata
21.3 Secrets storage

Sensitive items should not sit unprotected in the main database.

Use OS-backed secure storage where possible for:

AI provider keys
site shared secrets
signing private keys
refresh tokens
optional client credentials

The DB stores references and non-sensitive metadata.

21.4 Repository abstraction

All DB access goes through a repository layer with no raw SQL in UI or orchestration code. This allows future migration to MySQL/Postgres in hosted mode.

22. Data model
22.1 Core entities
Workspace
UserProfile
Site
SiteConnection
SiteConfig
DiscoverySnapshot
ChatThread
ChatMessage
Request
ClarificationRound
ActionPlan
Action
ApprovalRequest
ApprovalDecision
ExecutionRun
ToolInvocation
AuditEntry
RollbackRecord
ProviderProfile
Notification
Attachment
22.2 Key relationships
Workspace has many Sites
Site has one active SiteConfig and many config versions
Site has many Chats
Chat has many Requests
Request has one ActionPlan
ActionPlan has many Actions
Request may have many ClarificationRounds
Request may have zero or many ApprovalRequests
ExecutionRun belongs to one ActionPlan
AuditEntries belong to Site and Request and optionally Action
23. WordPress plugin architecture
23.1 Plugin role

The plugin acts as a secure execution bridge between the desktop app and the WordPress site.

It owns:

registration
auth verification
discovery
capability exposure
execution adapters to WordPress internals
event/result responses

It does not own:

conversation state
prompt logic
approvals
multi-site coordination
AI provider integration
cross-site analytics
23.2 Internal plugin modules
bootstrap
registration/settings
auth verifier
request signer/verifier
discovery service
action registry
validators
execution handlers
MCP server registration
audit callback hooks
compatibility checks
23.3 WordPress integration points

The plugin interacts with:

post APIs
taxonomy APIs
media APIs
menu APIs
capabilities/current user
REST API
Abilities API
MCP adapter package
SEO plugin APIs where supported
ACF APIs where supported and enabled
24. MCP implementation

The current official WordPress MCP adapter can be included in a plugin via Composer, supports custom MCP servers, and supports both HTTP and STDIO transports. The default server requires abilities to be marked public with meta.mcp.public when they are exposed via the default server.

24.1 Product decision

The companion plugin includes the official wordpress/mcp-adapter package via Composer and registers a custom MCP server for SitePilot-specific tools. This avoids relying solely on the generic default server and gives the product control over exactly which abilities are exposed and how they are named. The WordPress docs explicitly describe installing the package via Composer in your own plugin and creating/registering a custom MCP server.

24.2 Transport model

Two transport modes are supported:

HTTP mode

For live hosted sites. This is the default mode for real sites.

STDIO mode

For local development sites or diagnostics where WP-CLI access is available locally.

The official WordPress adapter supports both transport types, with STDIO used for local environments and HTTP used for public installs.

24.3 Connection strategy

Because SitePilot is its own host application, it should implement an internal MCP client layer and connect directly to the site’s HTTP MCP endpoint in normal operation, rather than depending on the external remote proxy as a runtime requirement. The official remote proxy remains useful for testing, debugging, and third-party client compatibility. The official docs describe the remote proxy path for public WordPress installs and authentication via application passwords or OAuth; SitePilot uses the same underlying HTTP-compatible model but owns the client runtime itself.

24.4 Tool design

The plugin exposes tools grouped by namespaces such as:

site.get_info
site.get_structure
content.list
content.get
content.create
content.update
content.publish
seo.set_meta
media.attach
menu.update
taxonomy.assign
audit.get_last_change

Each tool has:

JSON schema inputs
typed outputs
deterministic error codes
capability checks
dry-run support if available
risk metadata
24.5 Custom server over public default server

The product should prefer its own custom server over broad public default-server exposure. Public abilities on the default server remain acceptable for simple read-only capability discovery, but app-specific write actions should be intentionally exposed and tightly controlled.

25. Plugin authentication and trust model
25.1 Core requirement

The app must be the only trusted controller. The plugin must not behave as a public agent endpoint.

25.2 Authentication design

Each site connection stores:

site UUID
workspace UUID
trusted app URL/origin
client identifier
signing public key or shared secret fingerprint
credential status
rotation timestamp
protocol version

Each request from app to plugin includes:

signed headers
timestamp
nonce
request ID
site ID
optional user identity claim
payload hash

The plugin verifies:

app origin/allowlist
signature validity
timestamp freshness
nonce uniqueness
site status
protocol compatibility
25.3 Credential options

Primary recommendation:

asymmetric signing using app-held private key and plugin-held public key

Fallback:

shared secret HMAC signing
25.4 Rotation

The app and plugin must support credential rotation without losing site identity.

25.5 Revocation

Any connected site may be revoked by either side. Revoked sites immediately reject all new requests.

26. Permissions and user management
26.1 Product roles

At the app/workspace level:

Owner
Admin
Manager
Approver
Requester
Read-only auditor
26.2 Site roles

Per-site overrides allow:

can request
can edit drafts
can approve
can publish
can manage config
can manage connection
can view audit only
26.3 Local desktop reality

In local desktop mode, user management is primarily for:

app sign-in/profiles on the local instance
role-based behaviour inside a workspace
audit attribution
approval gating

True remote collaboration is supported more naturally in hosted mode, but the domain model should exist now so migration is seamless.

26.4 WordPress capability mapping

Every action executed by the plugin must also check WordPress-side capabilities. The app’s permissions are necessary but not sufficient.

27. AI provider model
27.1 Provider support

The app supports:

global provider credentials
optional workspace/client credentials
optional site-specific overrides

Resolution order:

site override
workspace/client override
app global default
27.2 Supported providers

Initial providers:

OpenAI
Anthropic

Future:

local model adapters
Azure/OpenAI-compatible providers
OpenRouter-style compatible endpoints
27.3 Provider abstraction

The app talks to providers through a model adapter interface.

Responsibilities:

chat completion
structured output
tool/function calling
embeddings if used
token/cost telemetry
retry policy
27.4 No provider keys in plugin

AI credentials remain in the desktop app only.

28. Agent orchestration
28.1 Agent pipeline

For every request:

ingest user message
attach site config and recent thread context
inspect request type
fetch live site context if needed
run clarification analysis
ask follow-up questions or continue
generate structured action plan
validate against site policy
present preview
await approval if needed
execute actions
record results
summarise outcome
28.2 Internal agents/subsystems

Recommended logical separation:

intent classifier
context builder
clarification engine
planner
compliance/rules checker
executor
summariser

These do not need separate model calls every time, but should be represented as separate services in code.

28.3 Context assembly

Context sources include:

site config
discovery snapshot
recent relevant chat history
target object summaries
prior changes to same object
approval rules
tool schemas
28.4 Prompting model

Prompt hierarchy:

Global locked rules

Hard-coded, not user editable.
Examples:

never execute unknown tools
never ignore approval rules
do not fabricate site structure
prefer editing existing relevant content over creating duplicates when appropriate
always produce structured action plans
Site config rules

Editable per site.
Examples:

allowed post types
tone
SEO standards
protected templates
menu policy
Thread/task context

User request, recent clarifications, attachments, selected objects.

28.5 Deterministic planning

The planner should output a typed plan object, not freeform prose. Example sections:

request summary
assumptions
open questions
target entities
proposed actions
approval requirement
risks
rollback notes
29. Validation and policy enforcement

Before execution, every action passes through:

schema validation
site policy validation
capability validation
dependency validation
environment validation
object existence validation
conflict detection
approval rule validation

The validator can return:

pass
pass with warnings
blocked pending clarification
blocked pending approval
blocked permanently
30. Media handling
30.1 Supported flows
choose existing media
upload new media from local file
attach externally sourced media where allowed
set featured image
update alt text
suggest crops/ratios
validate format/size
30.2 AI behaviour

The agent may:

ask for an image if missing
suggest using an existing library asset
generate alt text drafts
create a media brief if design work is required

It does not silently invent or download rights-sensitive imagery without explicit workflow support.

31. SEO and content quality subsystem
31.1 SEO capabilities

Subject to site config and plugin integration:

page title suggestion
SEO title setting
meta description setting
slug suggestion
redirect recommendation
internal linking suggestion
content duplication warnings
31.2 Plugin integration

Where supported, the plugin may integrate with specific SEO plugins through adapter modules. Unsupported plugins fall back to generic post meta handling where feasible.

31.3 Quality checks

The agent should flag:

duplicate titles
missing featured image
missing meta description
weak H1/title mismatch
empty excerpt where required
missing taxonomy assignments
publish without image on required post types
32. Menus and navigation

Menu changes are high risk by default.

Capabilities may include:

suggest menu placement
add page to menu
rename menu label
reorder item
remove item

All menu modifications require explicit config permission and usually approval.

33. Notifications

In desktop mode, notifications include:

in-app alerts
OS notifications
optional email relay if configured
optional Slack webhook if configured

Events:

approval required
execution completed
execution failed
site disconnected
plugin outdated
credential rotation needed
34. Logging and observability

The app maintains:

application logs
site communication logs
tool invocation logs
model/provider logs
error traces
audit logs

Logging levels:

debug
info
warning
error

Sensitive data redaction must apply by default.

35. Error handling
35.1 Error classes
auth failure
connectivity failure
protocol mismatch
validation failure
capability denied
approval missing
object conflict
provider failure
execution failure
partial execution failure
rollback failure
35.2 User-facing behaviour

Errors must be translated into understandable outcomes:

what failed
what was not changed
what may have changed already
next action
35.3 Idempotency

Every execution run must carry a request ID and idempotency key where relevant to avoid duplicate changes on retries.

36. Performance and caching

The app should cache:

discovery snapshots
site structure summaries
content summary records
tool schemas
capability maps

Live reads still occur where freshness matters, especially before executing changes.

Cache invalidation triggers:

completed writes
manual refresh
site plugin update
config change
scheduled refresh
37. Export, backup, and portability

The local app should support:

export workspace
export site config
export audit logs
export chats
export connection metadata without secrets
import configs into another app instance

This is important for local mode resilience and for future migration to hosted mode.

38. Packaging and distribution
38.1 Desktop app

The Electron app should be packaged for:

macOS
Windows

Linux optional.

38.2 WordPress plugin

Distribute as:

standard WordPress plugin ZIP
bundled Composer dependencies
versioned protocol compatibility
in-app downloadable plugin package optional
38.3 Updates

Desktop app and plugin must both publish compatibility metadata so the app can warn if:

plugin too old
protocol mismatch
unsupported tool schema version
site config requires newer capability
39. Security requirements
39.1 Core principles
least privilege
explicit allowlists
signed requests
no public unauthenticated write endpoints
approval on high-impact changes
secrets isolated from UI layer
no unrestricted shell/code execution
environment-aware restrictions
39.2 Prohibited capabilities by default
file editing
arbitrary PHP execution
plugin install/activate/deactivate
theme editing
database query execution
raw SQL
user management changes
option writes outside explicit safe allowlists

These may only exist through explicitly designed, privileged tools in advanced modes.

39.3 Environment protection

Each site may be marked:

production
staging
development

Rules can vary by environment, such as allowing auto-run on staging but not production.

40. Cloud readiness design

Although the initial product is local desktop, the architecture must support a future hosted control plane.

40.1 What must remain deployment-agnostic
domain models
site configs
request lifecycle
action schemas
approval system
MCP client abstraction
provider abstraction
repository interfaces
audit/event model
40.2 What changes when moving to cloud
renderer becomes web app
local DB becomes hosted relational DB
secrets manager moves server-side
notifications become centralised
multi-user collaboration becomes first-class
auth moves to hosted identity provider
background execution becomes queue-based
40.3 What should not change
plugin protocol
site registration model
action schemas
approval semantics
audit semantics
tool contract

That is the reason to keep the plugin thin and the app logic modular now.

41. Example supported requests
“Create a new page about bridging loans and put it under Services”
“Change the homepage hero title to X and update the CTA”
“Draft a new case study from this transcript”
“Update the meta description on the first-time buyer page”
“Find the page about remortgaging and add a section about early repayment charges”
“Create a blog post from this Slack message but don’t publish it”
“There’s already a similar page — should we update that instead?”
“This title is weak; give me three better SEO-friendly options”
“Add this new page to the footer menu only”
“Update 12 location pages with this new opening hours block, but show me the changes first”
42. Example system behaviour
Request

“I want to create a new page about equity release.”

Agent behaviour
inspect site config
find whether page or CPT is appropriate
search for similar existing content
check parent page rules and menu policy
ask:
should this be a page or use the Guides post type?
draft or publish?
should it go in the menu?
do you have imagery?
generate:
draft title
slug
body outline
SEO title
meta description
produce action plan
await approval if publish/menu update requested
execute on approval
log all actions
43. Open implementation decisions

These do not block the spec, but should be settled during design:

whether local app sign-in uses a master password, OS account, or both
whether the plugin exposes only MCP tools or also a thin signed REST layer for non-MCP diagnostics
how much full-content caching the desktop app stores locally
whether ACF integration is generic or adapter-based per field type
whether external channels are in scope for first release or post-launch
44. Recommended technical stance

The product should be implemented as:

Electron desktop app
TypeScript throughout
SQLite local persistence
OS-backed secure key storage
thin WordPress plugin
official WordPress MCP adapter embedded in the plugin via Composer
custom MCP server for product-defined tools
HTTP transport for live sites
strict signed-request trust model
mandatory per-site config
approval and audit first

That fits the product you described, preserves safety, and still leaves a clean path to a hosted control plane later.

If you want, I’ll turn this into a cleaner internal spec format next, like a proper PRD/TSD split with sections you could hand to a dev team.