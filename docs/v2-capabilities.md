# What Gutenberg v2 can do

Current as of 25 September 2026. This is the short, operator-facing reference for the v2 content engine in the local desktop app. For how it is built, see [v2 implementation](./v2-implementation.md). For what comes next, see the [v2 expansion plan](./v2-expansion-plan.md).

v2 is the default content engine. A site turns it off by defining `SITEPILOT_V2_ENABLED` as `false` in `wp-config.php`.

## How a request runs

1. **Request.** In a Request thread, describe the change and choose the operation: create a draft, replace all content, or apply selected changes to an existing post (by post ID).
2. **Candidate.** SitePilot plans the content and builds it inside the site's own WordPress editor, using WordPress's block APIs. It rejects anything the editor would not save cleanly.
3. **Review.** You see desktop and mobile screenshots, the new or changed blocks, any blocks deleted on purpose, and any post field changes. Follow-up messages in the same thread revise the candidate.
4. **Approve.** The approval is bound to the exact content, fields and media. It expires after 30 minutes.
5. **Write and verify.** SitePilot uploads the approved media and writes the post in one database transaction. It then reopens the post in a fresh editor and checks every block. A write only counts as successful after that check passes.

If the post changes in WordPress between review and write, the write is refused. If verification fails, the write is rolled back, unless someone has edited the post since. SitePilot never overwrites a later human edit.

## Operations

| Operation | What it does |
| --- | --- |
| Create draft | Creates a new post or page as a draft, with title, excerpt, featured image and content. |
| Replace all content | Rewrites the body of an existing post or page. Blocks that v2 cannot author must be kept or deleted on purpose; see below. |
| Apply selected changes | Inserts, edits, moves or removes individual blocks, and can do several in one request. Everything else in the post stays exactly as stored. |
| Post fields only | Changes the title, excerpt, featured image or SEO fields without touching the content. |

Existing posts keep their status. An approved edit to a published post updates the live post. WordPress keeps revisions.

## Blocks v2 can write

| Area | Blocks |
| --- | --- |
| Text | Paragraph, heading, list and list item, quote, pullquote, code, preformatted, details (expandable section) |
| Layout | Group, columns and column, separator, spacer, cover (image or colour banner with content on top), accordion (collapsible sections such as an FAQ) |
| Media | Image, gallery, media and text, video (media library or upload) |
| Embeds | YouTube and Vimeo videos |
| Other | Buttons and button, table |

Each block accepts a reviewed set of settings, such as alignment, colours, spacing, anchors and CSS classes. Anything outside that set is rejected rather than guessed.

## Editing existing posts safely

- **Untouched blocks are not rewritten.** They are written back from their exact stored bytes, and WordPress independently checks this at commit.
- **Blocks v2 cannot author are kept.** Examples are custom HTML, classic content, reusable blocks, social links, forms, plugin blocks, and blocks from inactive plugins. A request can keep them, move them, or delete them on purpose, but never edit inside them. A candidate that would drop one without saying so fails with `content_loss`.
- **Several changes work in one request.** For example, edit a paragraph, insert a heading, move a block and remove another.
- **Edits keep what they don't mention.** An edited block keeps its existing styles (font size, colours, typography, classes) and its nested blocks unless the request changes them.
- **Locked and bound blocks are respected.** Blocks locked against removal or moving, blocks with data bindings, and locked layouts are not changed.

## ACF blocks

- **Every ACF block on the site is discovered** with all of its fields: names, keys, types, defaults, choices, required flags, and sub fields of repeaters, groups and flexible content.
- **A block is written only after it passes a test on that site.** In the site's **Diagnostics** page, **Test ACF blocks** builds each block in the site's own editor with a value in every field, saves it, reopens it and renders it. A block that passes can be written; one that fails, or has not been tested, is kept untouched.
- **A changed field group or ACF update turns the block back to kept-only** until it is tested again.
- **Requests use the site's own fields.** For example, "a grey container with no padding" becomes the container's real colour and padding choices, with any field left out taking its default. A value that doesn't fit a field is sent back to the planner once to correct, and otherwise fails before review.
- **Editing an ACF block keeps the field values the request doesn't mention**, and blocks can be inserted inside ACF blocks that hold inner blocks.

## SEO fields

On sites running **Yoast SEO**, a request can set or change a post's SEO fields, on its own or together with content:

| Field | Yoast field |
| --- | --- |
| SEO title | SEO title (Yoast variables such as `%%title%% %%sep%% %%sitename%%` are kept as written) |
| Meta description | Meta description |
| Focus keyphrase | Focus keyphrase |
| Canonical URL | Canonical URL |
| Search indexing | "Allow search engines to show this content": site default, no (noindex) or yes |
| Social title and description | Facebook / Open Graph title and description |

- **Review** lists each SEO change. Leaving a field empty clears it back to the Yoast default.
- **Approval covers the SEO fields** like the title and excerpt. If someone changes the post's SEO fields in WordPress after review, the write is refused.
- **The SEO fields are written in the same database transaction as the post**, then read back and checked. If the check fails, they are rolled back to their exact previous values, unless someone has edited them since.
- **Only plain text is accepted**: no HTML, line breaks or double spaces, so what you approve is exactly what WordPress stores.
- Conversations can read a post's SEO fields ("what's the meta description on post 946?").

## Media

- **Images:** JPEG, PNG, WebP and GIF, attached in the chat or already in the media library.
- **Videos:** MP4 and WebM up to 10 MB, attached in the chat, or any existing media-library video.
- Attached media is only uploaded after approval, and only if the content uses it. Existing library files are reused, not duplicated.
- Every file is checksum-verified from attachment through to the live URL.
- YouTube and Vimeo links are checked through WordPress's oEmbed service before approval, so a private or deleted video fails early.
- PDF pages and screenshots can be attached as layout references. They are read by the planner and never uploaded.

## Conversations

Conversation threads are read-only research. They can:

- list, count and search posts and pages
- find the latest, oldest or random posts, and show IDs, URLs, dates and content
- read an external web page, and turn it into a new Request

They never change the site.

## Not yet

Planned work for each gap is in the [v2 roadmap](./v2-roadmap.md).

- **Other third-party blocks.** Plugin blocks other than ACF blocks are kept safely, but v2 cannot author them.
- **Some ACF field types.** ACF image and file fields take existing media-library IDs only, not attached media. Blocks that store their fields in post meta (`usePostMeta`), or that have a required field of a type v2 cannot fill (such as gallery, user or Google Map), stay kept-only.
- **Other SEO plugins.** Only Yoast SEO fields can be edited. RankMath and All in One SEO are detected but not written. The social (Open Graph) image cannot be set yet.
- **Publishing.** Publish, unpublish and schedule are not available; new content is always a draft (Phase 4).
- **Choosing the post from the message.** In a Request, "update the last created post" does not pick the post; enter the post ID. Conversations can find it (Phase 5).
- **Large videos.** Uploads over 10 MB need a streaming upload that is not built yet.
- **Embed previews.** YouTube and Vimeo embeds show as a blank frame in review screenshots, because third-party players are blocked there.
- **Posts with an invalid or old-format block** that v2 could author cannot be edited until the post is resaved in WordPress.
- **Other content types.** Only posts and pages are supported, not custom post types. Categories, tags, slug, author and date cannot be edited.
