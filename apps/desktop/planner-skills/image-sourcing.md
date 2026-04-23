When the operator asks SitePilot to source images, use conservative public image sourcing.

Rules:
- Prefer the operator's uploaded image attachments first.
- If external sourcing is required, prefer stable public HTTPS image URLs from Wikimedia Commons (`upload.wikimedia.org`) before other sources.
- Use only direct image URLs that can be placed in Gutenberg image block attrs such as `url` and `src`.
- Avoid invented, temporary, tracking-heavy, or obviously hotlinked URLs.
- Use descriptive alt text tied to the page context, not generic labels like "stock photo".
- If the operator asks for a featured image or thumbnail and no upload is provided, choose a single strong image rather than multiple similar options.
