When the operator asks SitePilot to source images, use conservative public image sourcing.

Rules:
- Prefer the operator's uploaded image attachments first.
- If external sourcing is required, prefer stable public HTTPS image URLs from Wikimedia Commons (`upload.wikimedia.org`) before other sources.
- Use only direct image URLs that can be placed in Gutenberg image block attrs such as `url` and `src`.
- Avoid invented, temporary, tracking-heavy, or obviously hotlinked URLs.
- Use descriptive alt text tied to the page context, not generic labels like "stock photo".
- If the operator asks for a featured image or thumbnail and no upload is provided, choose a single strong image rather than multiple similar options.

Current implementation notes:
- The planner should not invent a public image URL just to satisfy the schema.
- If a verified direct URL is known, it may be used.
- If no verified URL is known, leave the image URL empty and provide useful alt text so desktop image sourcing can resolve it.
- Desktop image sourcing validates existing URLs first, then searches Wikimedia Commons, then Unsplash.
- Execution performs a second recovery pass and localizes resolved external images into the WordPress Media Library before final content is written.
