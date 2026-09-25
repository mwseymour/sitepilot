/* global window, document, TextEncoder */
(function () {
  "use strict";

  const config = window.sitepilotV2Config || {};
  // The plugin passes the lists generated from GUTENBERG_V2_SUPPORT_MATRIX.
  // Without them nothing is authorable, so an old plugin fails closed.
  const policy = config.blockPolicy || {};
  const AUTHOR_BLOCKS = new Set(policy.authorBlocks || []);
  const FIXTURE_REQUIRED_BLOCKS = new Set(policy.fixtureRequiredBlocks || []);
  const REVIEWED_BLOCKS = new Set(policy.reviewedBlocks || []);
  const SOURCE_BLOCK = policy.sourceBlock || "sitepilot/source-block";
  // ACF blocks on this site with their fields, from the plugin's discovery.
  const ACF_BLOCKS = new Map(
    (Array.isArray(policy.acfBlocks) ? policy.acfBlocks : [])
      .filter((definition) => definition && typeof definition.name === "string")
      .map((definition) => [definition.name, definition])
  );
  // Attributes a media binding owns; an edit that re-binds media must not
  // carry the old values across.
  const MEDIA_ATTRIBUTES = {
    "core/image": ["id", "url"],
    "core/media-text": ["mediaId", "mediaUrl", "mediaType", "mediaLink"],
    "core/cover": ["id", "url", "backgroundType"],
    "core/video": ["id", "src"]
  };
  const MAX_BLOCKS = 500;
  const MAX_DEPTH = 12;
  const MAX_ISSUES = 200;
  const MAX_DIAGNOSTIC = 4096;

  function stableValue(value) {
    if (Array.isArray(value)) {
      return value.map(stableValue);
    }
    if (value && typeof value === "object") {
      return Object.keys(value)
        .sort()
        .reduce((result, key) => {
          result[key] = stableValue(value[key]);
          return result;
        }, {});
    }
    return value;
  }

  function stableJson(value) {
    return JSON.stringify(stableValue(value));
  }

  async function sha256(value) {
    const bytes = new TextEncoder().encode(
      typeof value === "string" ? value : stableJson(value)
    );
    return sha256Bytes(bytes);
  }

  async function sha256Bytes(bytes) {
    const digest = await window.crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  }

  function issue(code, phase, message, details = {}) {
    return {
      code,
      severity: "error",
      phase,
      message: String(message).slice(0, 2000),
      ...(details.blockName ? { blockName: details.blockName } : {}),
      ...(details.blockPath ? { blockPath: details.blockPath } : {}),
      ...(details.planRef ? { planRef: details.planRef } : {}),
      ...(details.expected !== undefined
        ? { expected: String(details.expected).slice(0, MAX_DIAGNOSTIC) }
        : {}),
      ...(details.actual !== undefined
        ? { actual: String(details.actual).slice(0, MAX_DIAGNOSTIC) }
        : {})
    };
  }

  function getSettings() {
    try {
      return window.wp.data.select("core/block-editor").getSettings() || {};
    } catch {
      return {};
    }
  }

  function isAllowed(name, settings) {
    const allowed = settings.allowedBlockTypes;
    if (allowed === false) {
      return false;
    }
    return !Array.isArray(allowed) || allowed.includes(name);
  }

  function supportMode(name, registered) {
    if (AUTHOR_BLOCKS.has(name)) {
      return "author";
    }
    if (FIXTURE_REQUIRED_BLOCKS.has(name) && REVIEWED_BLOCKS.has(name)) {
      return "author_when_reviewed";
    }
    // Registered blocks v2 cannot author are kept byte-for-byte in updates.
    return registered ? "preserve_only" : "unsupported";
  }

  function isAuthorable(capability) {
    return (
      !!capability &&
      capability.registered &&
      capability.allowed &&
      capability.lock === "none" &&
      (capability.v2Support === "author" ||
        capability.v2Support === "author_when_reviewed")
    );
  }

  function authorableName(name, capabilities) {
    return isAuthorable(
      capabilities.blocks.find((block) => block.name === name)
    );
  }

  function editorLockMode(settings) {
    const lock = settings.templateLock;
    if (lock === true || lock === "all" || lock === "contentOnly") {
      return "all";
    }
    if (lock === "insert" || lock === "move") {
      return lock;
    }
    return "none";
  }

  async function awaitEditorReady() {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      try {
        const editor =
          window.wp && window.wp.data && window.wp.data.select("core/editor");
        const postType =
          editor && typeof editor.getCurrentPostType === "function"
            ? editor.getCurrentPostType()
            : null;
        if (
          window.wp.blocks.getBlockTypes().length > 0 &&
          postType === config.context.postType
        ) {
          return;
        }
      } catch {
        // The editor stores register asynchronously after footer scripts run.
      }
      await new Promise((resolve) => window.setTimeout(resolve, 50));
    }
    throw new Error(
      "editor_unavailable: WordPress editor stores did not become ready."
    );
  }

  async function discover() {
    if (!window.wp || !window.wp.blocks || !window.wp.data) {
      throw new Error(
        "editor_unavailable: WordPress block APIs are not loaded."
      );
    }
    await awaitEditorReady();
    const settings = getSettings();
    const contextLock = editorLockMode(settings);
    const names = new Set([
      ...window.wp.blocks.getBlockTypes().map((type) => type.name),
      ...AUTHOR_BLOCKS,
      ...FIXTURE_REQUIRED_BLOCKS
    ]);
    const blocks = [];
    for (const name of Array.from(names).sort()) {
      const type = window.wp.blocks.getBlockType(name);
      const supports = (type && type.supports) || {};
      blocks.push({
        name,
        registered: !!type,
        allowed: !!type && isAllowed(name, settings),
        v2Support: supportMode(name, !!type),
        dynamic:
          FIXTURE_REQUIRED_BLOCKS.has(name) ||
          (!!type && typeof type.save !== "function"),
        attributeSchemaHash: await sha256((type && type.attributes) || {}),
        allowedParents: Array.isArray(type && type.parent) ? type.parent : [],
        allowedAncestors: Array.isArray(type && type.ancestor)
          ? type.ancestor
          : [],
        allowedChildren: Array.isArray(type && type.allowedBlocks)
          ? type.allowedBlocks
          : [],
        supportsHtml: supports.html !== false,
        lock: contextLock,
        ...(ACF_BLOCKS.has(name) ? { acf: acfDefinition(name) } : {})
      });
    }

    const editorSettingsFingerprint = await sha256({
      allowedBlockTypes:
        settings.allowedBlockTypes === undefined
          ? true
          : settings.allowedBlockTypes,
      templateLock: settings.templateLock || false,
      canLockBlocks: !!settings.canLockBlocks
    });
    const pluginFingerprint = await sha256({
      pluginFingerprint: config.pluginFingerprint || "",
      serverRuntimeFingerprint: config.serverRuntimeFingerprint || ""
    });
    const snapshot = {
      schemaVersion: "sitepilot.editor-capabilities/v2",
      siteId: config.siteId,
      siteUrl: config.siteUrl,
      bridgeVersion: config.bridgeVersion,
      wordpressVersion: config.wordpressVersion,
      ...(config.gutenbergVersion
        ? { gutenbergVersion: config.gutenbergVersion }
        : {}),
      capturedAt: new Date().toISOString(),
      context: {
        postType: config.context.postType,
        userId: config.userId,
        userRoles: config.userRoles,
        theme: config.theme,
        pluginFingerprint,
        editorSettingsFingerprint
      },
      blocks
    };
    snapshot.fingerprint = await sha256({ ...snapshot, capturedAt: undefined });
    return snapshot;
  }

  // The planner's view of an ACF block: its fields, without the per-site
  // fixture bookkeeping.
  function acfDefinition(name) {
    const { fixture, ...definition } = ACF_BLOCKS.get(name) || {};
    void fixture;
    return definition;
  }

  function cleanAttributes(node) {
    const attributes = { ...(node.attributes || {}) };
    delete attributes.mediaRef;
    return attributes;
  }

  function normalizedAttributeValue(
    blockName,
    attributePath,
    value,
    definition
  ) {
    if (
      definition &&
      (definition.source === "rich-text" || definition.type === "rich-text")
    ) {
      if (value === undefined || value === null) {
        return value;
      }
      const richText = window.wp.richText;
      // Code and preformatted text keep their line breaks as characters.
      const preserveWhiteSpace = !!definition.__unstablePreserveWhiteSpace;
      if (richText && typeof richText.toHTMLString === "function") {
        if (typeof value === "string") {
          if (typeof richText.create !== "function") {
            throw new Error(
              `WordPress cannot normalize rich-text input for ${blockName}.${attributePath}.`
            );
          }
          return richText.toHTMLString({
            value: richText.create({ html: value }),
            preserveWhiteSpace
          });
        }
        return richText.toHTMLString({ value, preserveWhiteSpace });
      }
      throw new Error(
        `WordPress returned an unreadable rich-text value for ${blockName}.${attributePath}.`
      );
    }
    if (Array.isArray(value)) {
      const childDefinition =
        definition && definition.items ? definition.items : null;
      return value.map((child, index) => {
        if (
          definition &&
          definition.query &&
          child &&
          typeof child === "object" &&
          !Array.isArray(child)
        ) {
          return Object.keys(child).reduce((result, key) => {
            result[key] = normalizedAttributeValue(
              blockName,
              `${attributePath}[${index}].${key}`,
              child[key],
              definition.query[key]
            );
            return result;
          }, {});
        }
        return normalizedAttributeValue(
          blockName,
          `${attributePath}[${index}]`,
          child,
          childDefinition
        );
      });
    }
    if (
      value &&
      typeof value === "object" &&
      definition &&
      (definition.properties || definition.query)
    ) {
      const definitions = definition.properties || definition.query;
      return Object.keys(value).reduce((result, key) => {
        result[key] = normalizedAttributeValue(
          blockName,
          `${attributePath}.${key}`,
          value[key],
          definitions[key]
        );
        return result;
      }, {});
    }
    return value;
  }

  function normalizedAttributes(blockName, attributes) {
    const type = window.wp.blocks.getBlockType(blockName);
    return Object.keys(attributes || {}).reduce((result, key) => {
      result[key] = normalizedAttributeValue(
        blockName,
        key,
        attributes[key],
        type && type.attributes ? type.attributes[key] : null
      );
      return result;
    }, {});
  }

  // Attributes the editor derives itself, so a constructed block reads back
  // exactly as WordPress parses it.
  function withDerivedAttributes(blockName, attributes) {
    const type = window.wp.blocks.getBlockType(blockName);
    const derived = { ...attributes };
    Object.entries((type && type.attributes) || {}).forEach(([key, definition]) => {
      // Booleans read from an HTML attribute parse as false when it is absent.
      if (
        definition &&
        definition.source === "attribute" &&
        definition.type === "boolean" &&
        derived[key] === undefined &&
        definition.default === undefined
      ) {
        derived[key] = false;
      }
    });
    if (
      blockName === "core/cover" &&
      (typeof derived.customOverlayColor === "string" ||
        typeof derived.overlayColor === "string")
    ) {
      derived.isUserOverlayColor = true;
    }
    return derived;
  }

  // The accordion's heading level and icon settings are copied onto each
  // heading, as the editor does when an accordion is configured.
  function withAccordionContext(node) {
    if (!node || node.name !== "core/accordion") return node;
    const settings = node.attributes || {};
    const headingAttributes = {
      ...(Number.isInteger(settings.headingLevel)
        ? { level: settings.headingLevel }
        : {}),
      ...(settings.iconPosition !== undefined
        ? { iconPosition: settings.iconPosition }
        : {}),
      ...(settings.showIcon !== undefined ? { showIcon: settings.showIcon } : {})
    };
    return {
      ...node,
      children: (node.children || []).map((item) =>
        item && item.name === "core/accordion-item"
          ? {
              ...item,
              children: (item.children || []).map((child) =>
                child && child.name === "core/accordion-heading"
                  ? {
                      ...child,
                      attributes: {
                        ...headingAttributes,
                        ...(child.attributes || {}),
                        ...(item.attributes && item.attributes.openByDefault
                          ? { openByDefault: true }
                          : {})
                      }
                    }
                  : child
              )
            }
          : item
      )
    };
  }

  function containsSerializedBlockDelimiter(value) {
    if (typeof value === "string") {
      const decoded = document.createElement("textarea");
      decoded.innerHTML = value;
      const delimiter = /<\s*!--\s*\/?wp:/i;
      return delimiter.test(value) || delimiter.test(decoded.value);
    }
    if (Array.isArray(value)) {
      return value.some((entry) => containsSerializedBlockDelimiter(entry));
    }
    if (value && typeof value === "object") {
      return Object.values(value).some((entry) =>
        containsSerializedBlockDelimiter(entry)
      );
    }
    return false;
  }

  function blockMediaRefs(intent) {
    const refs = new Set();
    const visit = (nodes) => {
      (Array.isArray(nodes) ? nodes : []).forEach((node) => {
        if (!node || typeof node !== "object") return;
        const ref = node.attributes && node.attributes.mediaRef;
        if (typeof ref === "string") refs.add(ref);
        visit(node.children);
      });
    };
    visit(intent && intent.blocks);
    ((intent && intent.operations) || []).forEach((operation) => {
      visit(operation && operation.blocks);
      if (operation && operation.replacement) visit([operation.replacement]);
    });
    return refs;
  }

  function countNodes(nodes) {
    return nodes.reduce(
      (count, node) =>
        count + 1 + countNodes(node.children || node.innerBlocks || []),
      0
    );
  }

  function createNode(
    node,
    parentName,
    ancestors,
    path,
    capabilities,
    issues,
    depth,
    context = null,
    keptInnerBlocks = null
  ) {
    node = withAccordionContext(node);
    if (node && node.name === SOURCE_BLOCK) {
      if (!context || typeof context.claimSource !== "function") {
        issues.push(
          issue(
            "schema_invalid",
            "policy",
            "Kept source blocks are only valid when updating an existing post.",
            { blockPath: path, planRef: node.ref }
          )
        );
        return null;
      }
      return context.claimSource(node, parentName, ancestors, path, issues);
    }
    if (depth > MAX_DEPTH) {
      issues.push(
        issue(
          "invalid_nesting",
          "policy",
          "Block nesting exceeds the v2 limit.",
          { blockName: node.name, blockPath: path, planRef: node.ref }
        )
      );
      return null;
    }
    if (
      containsSerializedBlockDelimiter(node.attributes || {}) ||
      containsSerializedBlockDelimiter(node.innerHTML)
    ) {
      issues.push(
        issue(
          "invalid_block_markup",
          "policy",
          "Rich text must not contain serialized Gutenberg block delimiters.",
          { blockName: node.name, blockPath: path, planRef: node.ref }
        )
      );
      return null;
    }
    const capability = capabilities.blocks.find(
      (block) => block.name === node.name
    );
    if (!capability || !capability.registered) {
      issues.push(
        issue(
          "unregistered_block",
          "policy",
          `Block ${node.name} is not registered.`,
          { blockName: node.name, blockPath: path, planRef: node.ref }
        )
      );
      return null;
    }
    if (!capability.allowed) {
      issues.push(
        issue(
          "disallowed_block",
          "policy",
          `Block ${node.name} is disabled in this editor context.`,
          { blockName: node.name, blockPath: path, planRef: node.ref }
        )
      );
      return null;
    }
    if (
      capability.v2Support !== "author" &&
      capability.v2Support !== "author_when_reviewed"
    ) {
      issues.push(
        issue(
          "unsupported_v2_block",
          "policy",
          `Block ${node.name} has not passed the v2 fixture gate.`,
          { blockName: node.name, blockPath: path, planRef: node.ref }
        )
      );
      return null;
    }
    if (capability.lock !== "none") {
      issues.push(
        issue(
          "locked_structure",
          "policy",
          `The editor context does not permit authoring ${node.name}.`,
          { blockName: node.name, blockPath: path, planRef: node.ref }
        )
      );
      return null;
    }
    if (
      capability.allowedParents.length &&
      (!parentName || !capability.allowedParents.includes(parentName))
    ) {
      issues.push(
        issue(
          "invalid_nesting",
          "policy",
          `Block ${node.name} is not allowed at this parent.`,
          { blockName: node.name, blockPath: path, planRef: node.ref }
        )
      );
      return null;
    }
    if (
      capability.allowedAncestors.length &&
      !ancestors.some((name) => capability.allowedAncestors.includes(name))
    ) {
      issues.push(
        issue(
          "invalid_nesting",
          "policy",
          `Block ${node.name} requires an allowed ancestor.`,
          { blockName: node.name, blockPath: path, planRef: node.ref }
        )
      );
      return null;
    }
    const parentCapability = parentName
      ? capabilities.blocks.find((block) => block.name === parentName)
      : null;
    if (
      parentCapability &&
      parentCapability.allowedChildren.length &&
      !parentCapability.allowedChildren.includes(node.name)
    ) {
      issues.push(
        issue(
          "invalid_nesting",
          "policy",
          `Block ${parentName} does not allow child ${node.name}.`,
          { blockName: node.name, blockPath: path, planRef: node.ref }
        )
      );
      return null;
    }
    const childAncestors = [...ancestors, node.name];
    const children = keptInnerBlocks
      ? keptInnerBlocks
      : (node.children || [])
          .map((child, index) =>
            createNode(
              child,
              node.name,
              childAncestors,
              [...path, index],
              capabilities,
              issues,
              depth + 1,
              context
            )
          )
          .filter(Boolean);
    if (!keptInnerBlocks && children.length !== (node.children || []).length) {
      return null;
    }
    try {
      const requestedAttributes = withDerivedAttributes(
        node.name,
        normalizedAttributes(node.name, cleanAttributes(node))
      );
      const block = window.wp.blocks.createBlock(
        node.name,
        requestedAttributes,
        children
      );
      const constructedAttributes = Object.keys(requestedAttributes).reduce(
        (result, key) => {
          const type = window.wp.blocks.getBlockType(node.name);
          result[key] = normalizedAttributeValue(
            node.name,
            key,
            block.attributes ? block.attributes[key] : undefined,
            type && type.attributes ? type.attributes[key] : null
          );
          return result;
        },
        {}
      );
      if (
        stableJson(requestedAttributes) !== stableJson(constructedAttributes)
      ) {
        issues.push(
          issue(
            "content_changed",
            "compile",
            `WordPress changed attributes while constructing ${node.name}.`,
            {
              blockName: node.name,
              blockPath: path,
              planRef: node.ref,
              expected: stableJson(requestedAttributes),
              actual: stableJson(constructedAttributes)
            }
          )
        );
        return null;
      }
      return block;
    } catch (error) {
      issues.push(
        issue(
          "invalid_block_markup",
          "compile",
          error && error.message ? error.message : "Block construction failed.",
          { blockName: node.name, blockPath: path, planRef: node.ref }
        )
      );
      return null;
    }
  }

  function parsedNodeShape(block) {
    return {
      name: block.name,
      attributes: normalizedAttributes(block.name, block.attributes || {}),
      children: (block.innerBlocks || []).map(parsedNodeShape)
    };
  }

  async function nodeFingerprint(block) {
    return sha256(parsedNodeShape(block));
  }

  function locate(roots, path) {
    let siblings = roots;
    let node = null;
    for (const index of path) {
      if (!Number.isInteger(index) || index < 0 || index >= siblings.length) {
        return null;
      }
      node = siblings[index];
      siblings = node.innerBlocks || [];
    }
    return node;
  }

  // ---- Existing content ------------------------------------------------------
  // Updates edit a working tree of the source post. Blocks the plan does not
  // touch are written back from their exact stored bytes; only blocks the plan
  // authors, or whose child list changes, are regenerated by WordPress. Blocks
  // v2 cannot author are kept as opaque units: they can stay, move or be
  // removed explicitly, never edited inside or dropped silently.

  // Same token grammar as @wordpress/block-serialization-default-parser.
  const TOKEN_PATTERN =
    /<!--\s+(\/)?wp:([a-z][a-z0-9_-]*\/)?([a-z][a-z0-9_-]*)\s+({(?:(?=([^}]+|}+(?=})|(?!}\s+\/?-->)[^])*)\5|[^]*?)}\s+)?(\/)?-->/g;

  function tokenize(content) {
    const roots = [];
    const stack = [];
    let offset = 0;
    const add = (node) => {
      if (stack.length) stack[stack.length - 1].children.push(node);
      else roots.push(node);
    };
    const addFreeform = (start, end) => {
      if (end > start && content.slice(start, end).trim() !== "") {
        roots.push({
          name: null,
          start,
          end,
          openEnd: start,
          closeStart: end,
          children: []
        });
      }
    };
    const pattern = new RegExp(TOKEN_PATTERN.source, "g");
    let match;
    while ((match = pattern.exec(content)) !== null) {
      const start = match.index;
      const end = start + match[0].length;
      const name = (match[2] || "core/") + match[3];
      const closer = !!match[1];
      const isVoid = !!match[6];
      if (!stack.length) addFreeform(offset, start);
      if (isVoid && !closer) {
        add({ name, start, end, openEnd: end, closeStart: end, children: [] });
      } else if (!closer) {
        stack.push({
          name,
          start,
          end,
          openEnd: end,
          closeStart: null,
          children: []
        });
      } else if (stack.length) {
        const frame = stack.pop();
        frame.closeStart = start;
        frame.end = end;
        add(frame);
      }
      offset = end;
    }
    while (stack.length) {
      const frame = stack.pop();
      frame.closeStart = content.length;
      frame.end = content.length;
      add(frame);
      offset = content.length;
    }
    if (offset < content.length) addFreeform(offset, content.length);
    return roots;
  }

  function ownText(content, span) {
    if (span.closeStart === null || span.closeStart === span.openEnd) return "";
    let text = "";
    let cursor = span.openEnd;
    for (const child of span.children) {
      text += content.slice(cursor, child.start);
      cursor = child.end;
    }
    return text + content.slice(cursor, span.closeStart);
  }

  // Pairs parsed blocks with their byte ranges. wp.blocks.parse drops
  // whitespace and unregistered blocks with no HTML of their own; those
  // ranges become hidden nodes that are always written back unchanged.
  function alignLevel(content, richNodes, spans) {
    const result = [];
    let next = 0;
    for (const span of spans) {
      const rich = richNodes[next];
      if (span.name === null) {
        if (!rich || rich.name !== "core/freeform") return null;
        result.push({ rich, span });
        next += 1;
        continue;
      }
      if (window.wp.blocks.getBlockType(span.name)) {
        if (!rich || rich.name !== span.name) return null;
        result.push({ rich, span });
        next += 1;
        continue;
      }
      if (
        rich &&
        rich.name === "core/missing" &&
        rich.attributes &&
        rich.attributes.originalName === span.name
      ) {
        result.push({ rich, span });
        next += 1;
      } else if (ownText(content, span).trim() === "") {
        result.push({ rich: null, span, hidden: true });
      } else if (rich) {
        // A legacy name that the parser converted (for example cover-image).
        result.push({ rich, span });
        next += 1;
      } else {
        return null;
      }
    }
    return next === richNodes.length ? result : null;
  }

  function textSummary(rich) {
    const html = (rich && rich.originalContent) || "";
    const holder = document.createElement("div");
    holder.innerHTML = html;
    const text = (holder.textContent || "").replace(/\s+/g, " ").trim();
    return text.length > 160 ? `${text.slice(0, 157)}...` : text;
  }

  async function buildSourceModel(rawContent, capabilities, issues) {
    const content = rawContent || "";
    let richRoots;
    try {
      richRoots = window.wp.blocks.parse(content);
    } catch {
      issues.push(
        issue(
          "invalid_block_markup",
          "compile",
          "The source content cannot be parsed."
        )
      );
      return null;
    }
    if (countNodes(richRoots) > MAX_BLOCKS) {
      issues.push(
        issue(
          "request_too_large",
          "schema",
          "Existing content exceeds the v2 block limit."
        )
      );
      return null;
    }
    const root = {
      kind: "root",
      state: "pristine",
      path: [],
      parent: null,
      rich: null,
      span: { start: 0, end: content.length, children: [] },
      children: [],
      original: [],
      originalKids: []
    };
    const byPath = new Map();
    const fingerprints = new Map();
    const wrapLevel = async (parent, richNodes, spanNodes, path, inside) => {
      const aligned = spanNodes ? alignLevel(content, richNodes, spanNodes) : null;
      if (!aligned) parent.opaqueChildren = true;
      const entries = aligned || richNodes.map((rich) => ({ rich, span: null }));
      let index = 0;
      for (const entry of entries) {
        if (entry.hidden) {
          const hidden = {
            kind: "hidden",
            state: "pristine",
            span: entry.span,
            parent,
            children: [],
            originalKids: []
          };
          hidden.slot = { node: hidden, anchorOf: null };
          parent.children.push(hidden.slot);
          parent.originalKids.push(hidden);
          continue;
        }
        const nodePath = [...path, index];
        index += 1;
        const node = {
          kind: "source",
          state: "pristine",
          rich: entry.rich,
          span: entry.span,
          path: nodePath,
          parent,
          children: [],
          original: [],
          originalKids: [],
          opaqueChildren: false,
          authorable: authorableName(entry.rich.name, capabilities),
          insidePreserved: inside
        };
        node.slot = { node, anchorOf: node };
        parent.children.push(node.slot);
        parent.original.push(node);
        parent.originalKids.push(node);
        byPath.set(nodePath.join("/"), node);
        fingerprints.set(nodePath.join("/"), await nodeFingerprint(entry.rich));
        await wrapLevel(
          node,
          entry.rich.innerBlocks || [],
          entry.span ? entry.span.children : null,
          nodePath,
          inside || !node.authorable
        );
      }
    };
    await wrapLevel(root, richRoots, tokenize(content), [], false);
    if (root.opaqueChildren) {
      issues.push(
        issue(
          "invalid_block_markup",
          "compile",
          "The stored content could not be matched to its parsed blocks, so it cannot be edited safely."
        )
      );
      return null;
    }
    // Blocks v2 regenerates must be valid today; everything v2 cannot author
    // is written back unchanged and is not re-validated.
    for (const node of byPath.values()) {
      if (node.authorable && !node.insidePreserved && !validationAdapter(node.rich)) {
        issues.push(
          issue(
            "invalid_block_markup",
            "policy",
            `Existing block ${node.rich.name} is invalid in this editor. Open the post in WordPress and resolve the block first.`,
            { blockName: node.rich.name, blockPath: node.path }
          )
        );
      }
    }
    if (issues.length) return null;
    return {
      content,
      root,
      byPath,
      fingerprints,
      treeFingerprint: await sha256(richRoots.map(parsedNodeShape)),
      claimed: new Map(),
      claimedNodes: new Set(),
      strictRemoved: new Set(),
      selfRemoved: new Set()
    };
  }

  function liveChildren(node) {
    return node.children.filter((slot) => slot.node).map((slot) => slot.node);
  }

  function attached(node) {
    for (let current = node; current && current.kind !== "root"; current = current.parent) {
      if (!current.slot || current.slot.node !== current) return false;
    }
    return true;
  }

  function isDescendant(node, ancestor) {
    for (let current = node; current; current = current.parent) {
      if (current === ancestor) return true;
    }
    return false;
  }

  function markDirty(node) {
    for (let current = node; current; current = current.parent) {
      if (current.state === "pristine") current.state = "children";
    }
  }

  function namesOf(node) {
    const names = [];
    for (let current = node; current && current.kind !== "root"; current = current.parent) {
      names.unshift(current.rich.name);
    }
    return names;
  }

  function blockAttributes(node) {
    return (node && node.rich && node.rich.attributes) || {};
  }

  function templateLocked(node) {
    const lock = blockAttributes(node).templateLock;
    return lock === "all" || lock === "insert" || lock === "contentOnly";
  }

  function lockedFor(node, action) {
    const lock = blockAttributes(node).lock;
    return !!(lock && lock[action]);
  }

  function hasBindings(node) {
    const metadata = blockAttributes(node).metadata;
    return !!(
      metadata &&
      metadata.bindings &&
      Object.keys(metadata.bindings).length
    );
  }

  function resolveSource(model, target, label, issues, allowRoot) {
    const key = target.path.join("/");
    const node = target.path.length
      ? model.byPath.get(key)
      : allowRoot
        ? model.root
        : null;
    const expected = target.path.length
      ? model.fingerprints.get(key)
      : model.treeFingerprint;
    if (!node || expected === undefined) {
      issues.push(
        issue(
          "invalid_nesting",
          "compile",
          `${label} refers to a block path that does not exist in the source.`,
          { blockPath: target.path }
        )
      );
      return null;
    }
    if (expected !== target.expectedFingerprint) {
      issues.push(
        issue("stale_source", "compile", `${label} target fingerprint changed.`, {
          blockPath: target.path,
          expected: target.expectedFingerprint,
          actual: expected
        })
      );
      return null;
    }
    return node;
  }

  // Whether the child list of `parent` may change (insert, remove, move).
  function canChangeChildren(parent, label, issues) {
    if (parent.kind === "root") return true;
    const name = parent.rich.name;
    let reason = null;
    if (parent.kind !== "source" || !attached(parent)) {
      reason = `${label} conflicts with another operation on the same block.`;
    } else if (!parent.authorable || parent.insidePreserved) {
      reason = `${label} would change the inside of ${name}, which v2 keeps unchanged.`;
    } else if (parent.opaqueChildren || !parent.span) {
      reason = `${label} targets ${name}, whose stored format can only be edited as a whole.`;
    } else if (templateLocked(parent)) {
      reason = `${label} would change ${name}, whose layout is locked.`;
    }
    if (reason) {
      issues.push(
        issue("locked_structure", "compile", reason, {
          blockName: name,
          blockPath: parent.path
        })
      );
      return false;
    }
    return true;
  }

  function canTouch(node, label, issues) {
    const name = node.rich ? node.rich.name : undefined;
    if (node.kind !== "source" || !node.span || !attached(node)) {
      issues.push(
        issue(
          "locked_structure",
          "compile",
          `${label} targets a block that another operation already changed, or whose stored format cannot be addressed.`,
          { blockName: name, blockPath: node.path }
        )
      );
      return false;
    }
    if (node.insidePreserved) {
      issues.push(
        issue(
          "locked_structure",
          "compile",
          `${label} targets a block inside a block v2 keeps unchanged.`,
          { blockName: name, blockPath: node.path }
        )
      );
      return false;
    }
    return canChangeChildren(node.parent, label, issues);
  }

  function checkPlacement(
    name,
    parentName,
    ancestors,
    capabilities,
    label,
    issues,
    path
  ) {
    const capability = capabilities.blocks.find((block) => block.name === name);
    const parentCapability = parentName
      ? capabilities.blocks.find((block) => block.name === parentName)
      : null;
    const invalid =
      (capability &&
        capability.allowedParents.length &&
        (!parentName || !capability.allowedParents.includes(parentName))) ||
      (capability &&
        capability.allowedAncestors.length &&
        !ancestors.some((ancestor) =>
          capability.allowedAncestors.includes(ancestor)
        )) ||
      (parentCapability &&
        parentCapability.allowedChildren.length &&
        !parentCapability.allowedChildren.includes(name));
    if (invalid) {
      issues.push(
        issue(
          "invalid_nesting",
          "compile",
          `${label}: ${name} is not allowed inside ${parentName || "the post root"}.`,
          { blockName: name, blockPath: path }
        )
      );
      return false;
    }
    return true;
  }

  function anchorPosition(parent, index, label, issues) {
    if (index > parent.original.length) {
      issues.push(
        issue(
          "invalid_nesting",
          "compile",
          `${label} insertion index is out of range.`,
          { blockPath: parent.path }
        )
      );
      return null;
    }
    if (index === parent.original.length) return parent.children.length;
    const anchor = parent.original[index];
    return parent.children.findIndex((slot) => slot.anchorOf === anchor);
  }

  function place(node, parent, position) {
    const slot = { node, anchorOf: null };
    node.slot = slot;
    node.parent = parent;
    parent.children.splice(position, 0, slot);
    return slot;
  }

  function wrapNew(model, rich, parent) {
    const node = {
      kind: "new",
      state: "new",
      rich,
      parent,
      children: [],
      originalKids: []
    };
    node.children = (rich.innerBlocks || []).map((child) => {
      const kept = model.claimed.get(child);
      const childNode = kept || wrapNew(model, child, node);
      childNode.parent = node;
      const slot = { node: childNode, anchorOf: null };
      childNode.slot = slot;
      return slot;
    });
    return node;
  }

  function richOf(node) {
    if (node.kind === "hidden") return null;
    if (node.kind === "source" && node.state === "pristine") return node.rich;
    if (node.kind === "source") {
      return {
        ...node.rich,
        innerBlocks: liveChildren(node).map(richOf).filter(Boolean)
      };
    }
    return node.rich;
  }

  function claimContext(model, capabilities, allowClaims) {
    return {
      claimSource(reference, parentName, ancestors, path, issues) {
        if (!allowClaims) {
          issues.push(
            issue(
              "schema_invalid",
              "policy",
              "Use move_block to relocate an existing block.",
              { blockPath: path, planRef: reference.ref }
            )
          );
          return null;
        }
        const node = resolveSource(
          model,
          reference.attributes || { path: [] },
          `Kept block ${reference.ref}`,
          issues,
          false
        );
        if (!node) return null;
        if (node.kind !== "source" || !node.span || node.insidePreserved) {
          issues.push(
            issue(
              "locked_structure",
              "compile",
              `Kept block ${reference.ref} cannot be taken out of its current place.`,
              { blockName: node.rich && node.rich.name, blockPath: node.path }
            )
          );
          return null;
        }
        for (const other of model.claimedNodes) {
          if (isDescendant(node, other) || isDescendant(other, node)) {
            issues.push(
              issue(
                "schema_invalid",
                "policy",
                `Kept block ${reference.ref} overlaps another kept block.`,
                { blockPath: node.path }
              )
            );
            return null;
          }
        }
        if (
          !checkPlacement(
            node.rich.name,
            parentName,
            ancestors,
            capabilities,
            `Kept block ${reference.ref}`,
            issues,
            path
          )
        ) {
          return null;
        }
        if (node.slot && node.slot.node === node) {
          node.slot.node = null;
          markDirty(node.parent);
        }
        model.claimedNodes.add(node);
        const rich = richOf(node);
        model.claimed.set(rich, node);
        return rich;
      }
    };
  }

  function deepMerge(base, extra) {
    const result = { ...base };
    Object.keys(extra).forEach((key) => {
      const left = result[key];
      const right = extra[key];
      result[key] =
        left &&
        right &&
        typeof left === "object" &&
        typeof right === "object" &&
        !Array.isArray(left) &&
        !Array.isArray(right)
          ? deepMerge(left, right)
          : right;
    });
    return result;
  }

  // An edit of the same block type keeps the attributes the plan does not
  // mention (font size, colour presets, typography, metadata, classes).
  function withSourceAttributes(node, replacement) {
    if (!replacement || replacement.name !== node.rich.name) return replacement;
    const source = normalizedAttributes(node.rich.name, node.rich.attributes || {});
    const requested = replacement.attributes || {};
    const skip = new Set(Object.keys(requested));
    skip.add("mediaRef");
    if (typeof requested.mediaRef === "string") {
      (MEDIA_ATTRIBUTES[node.rich.name] || []).forEach((key) => skip.add(key));
    }
    const carried = {};
    Object.keys(source).forEach((key) => {
      if (!skip.has(key) && source[key] !== undefined) carried[key] = source[key];
    });
    const attributes = { ...carried, ...requested };
    if (
      source.style &&
      typeof source.style === "object" &&
      requested.style &&
      typeof requested.style === "object"
    ) {
      attributes.style = deepMerge(source.style, requested.style);
    }
    // ACF field values the edit does not restate keep their stored values.
    if (
      ACF_BLOCKS.has(node.rich.name) &&
      source.data &&
      typeof source.data === "object" &&
      requested.data &&
      typeof requested.data === "object"
    ) {
      attributes.data = { ...source.data, ...requested.data };
    }
    return { ...replacement, attributes };
  }

  function editorLock(capabilities) {
    return (capabilities.blocks[0] && capabilities.blocks[0].lock) || "none";
  }

  function applyOperations(model, plan, capabilities, issues) {
    const lock = editorLock(capabilities);
    for (const operation of plan.operations) {
      const label = `Operation ${operation.id}`;
      if (lock !== "none") {
        issues.push(
          issue(
            "locked_structure",
            "policy",
            `${label} cannot change a post whose editor layout is locked.`
          )
        );
        continue;
      }
      if (operation.type === "insert_blocks") {
        const parent = resolveSource(model, operation.parent, label, issues, true);
        if (!parent || !canChangeChildren(parent, label, issues)) continue;
        const position = anchorPosition(parent, operation.index, label, issues);
        if (position === null) continue;
        const parentName = parent.kind === "root" ? null : parent.rich.name;
        const ancestors = parent.kind === "root" ? [] : namesOf(parent);
        const context = claimContext(model, capabilities, false);
        const created = operation.blocks
          .map((node, index) =>
            createNode(
              node,
              parentName,
              ancestors,
              [...parent.path, operation.index + index],
              capabilities,
              issues,
              parent.path.length + 1,
              context
            )
          )
          .filter(Boolean);
        if (created.length !== operation.blocks.length) continue;
        created.forEach((rich, index) =>
          place(wrapNew(model, rich, parent), parent, position + index)
        );
        markDirty(parent);
      } else if (operation.type === "remove_block") {
        const node = resolveSource(model, operation.target, label, issues, false);
        if (!node || !canTouch(node, label, issues)) continue;
        if (lockedFor(node, "remove")) {
          issues.push(
            issue("locked_structure", "compile", `${label}: ${node.rich.name} is locked against removal.`, {
              blockName: node.rich.name,
              blockPath: node.path
            })
          );
          continue;
        }
        node.slot.node = null;
        markDirty(node.parent);
        model.strictRemoved.add(node);
      } else if (operation.type === "move_block") {
        const node = resolveSource(model, operation.target, label, issues, false);
        const parent = resolveSource(model, operation.parent, label, issues, true);
        if (!node || !parent) continue;
        if (!canTouch(node, label, issues) || !canChangeChildren(parent, label, issues))
          continue;
        if (lockedFor(node, "move")) {
          issues.push(
            issue("locked_structure", "compile", `${label}: ${node.rich.name} is locked against moving.`, {
              blockName: node.rich.name,
              blockPath: node.path
            })
          );
          continue;
        }
        if (isDescendant(parent, node)) {
          issues.push(
            issue("invalid_nesting", "compile", `${label} would move a block inside itself.`, {
              blockPath: node.path
            })
          );
          continue;
        }
        if (
          !checkPlacement(
            node.rich.name,
            parent.kind === "root" ? null : parent.rich.name,
            parent.kind === "root" ? [] : namesOf(parent),
            capabilities,
            label,
            issues,
            node.path
          )
        )
          continue;
        const position = anchorPosition(parent, operation.index, label, issues);
        if (position === null) continue;
        const from = node.parent;
        node.slot.node = null;
        markDirty(from);
        place(node, parent, position);
        markDirty(parent);
      } else if (operation.type === "edit_block") {
        const node = resolveSource(model, operation.target, label, issues, false);
        if (!node || !canTouch(node, label, issues)) continue;
        if (hasBindings(node)) {
          issues.push(
            issue("locked_structure", "compile", `${label}: ${node.rich.name} is bound to other data and cannot be replaced.`, {
              blockName: node.rich.name,
              blockPath: node.path
            })
          );
          continue;
        }
        const parent = node.parent;
        const parentName = parent.kind === "root" ? null : parent.rich.name;
        const ancestors = parent.kind === "root" ? [] : namesOf(parent);
        const replacement = withSourceAttributes(node, operation.replacement);
        const existing = liveChildren(node);
        let kept = null;
        if ((replacement.children || []).length === 0 && existing.length > 0) {
          if (
            replacement.name !== node.rich.name ||
            node.opaqueChildren ||
            existing.some((child) => child.kind === "source" && !child.span)
          ) {
            issues.push(
              issue(
                "content_loss",
                "compile",
                `${label} would drop the blocks inside ${node.rich.name}. Restate them, keep them with ${SOURCE_BLOCK}, or remove them explicitly.`,
                { blockName: node.rich.name, blockPath: node.path }
              )
            );
            continue;
          }
          kept = existing;
        }
        const rich = createNode(
          replacement,
          parentName,
          ancestors,
          node.path,
          capabilities,
          issues,
          node.path.length,
          claimContext(model, capabilities, true),
          kept ? kept.map(richOf).filter(Boolean) : null
        );
        if (!rich) continue;
        let next;
        if (kept) {
          next = { kind: "new", state: "new", rich, parent, children: [], originalKids: [] };
          next.children = kept.map((child) => {
            const slot = { node: child, anchorOf: null };
            child.slot = slot;
            child.parent = next;
            return slot;
          });
        } else {
          next = wrapNew(model, rich, parent);
        }
        next.slot = node.slot;
        node.slot.node = next;
        markDirty(parent);
        model.selfRemoved.add(node);
      }
    }
  }

  function replaceContent(model, plan, capabilities, issues) {
    const context = claimContext(model, capabilities, true);
    const created = plan.blocks
      .map((node, index) =>
        createNode(node, null, [], [index], capabilities, issues, 1, context)
      )
      .filter(Boolean);
    if (created.length !== plan.blocks.length) return;
    const root = model.root;
    root.children = [];
    created.forEach((rich, index) => {
      const node = model.claimed.get(rich) || wrapNew(model, rich, root);
      place(node, root, index);
    });
    root.state = "children";
  }

  // Blocks v2 cannot author must survive unless the plan removes them
  // explicitly: by remove_block, by listing them in removedSourceBlocks, or
  // by replacing that exact block with edit_block.
  function checkContentLoss(model, plan, issues) {
    (plan.removedSourceBlocks || []).forEach((target, index) => {
      const node = resolveSource(
        model,
        target,
        `removedSourceBlocks[${index}]`,
        issues,
        false
      );
      if (node) model.strictRemoved.add(node);
    });
    const reachable = new Set();
    const collect = (node) => {
      liveChildren(node).forEach((child) => {
        reachable.add(child);
        collect(child);
      });
    };
    collect(model.root);
    const visit = (node, removed) => {
      node.originalKids.forEach((child) => {
        const explicitly = removed || model.strictRemoved.has(child);
        const preserved =
          child.kind === "hidden" || (child.kind === "source" && !child.authorable);
        if (!reachable.has(child) && preserved) {
          if (!explicitly && !model.selfRemoved.has(child)) {
            const name =
              child.kind === "hidden"
                ? child.span && child.span.name
                : child.rich.name;
            issues.push(
              issue(
                "content_loss",
                "compile",
                child.kind === "hidden"
                  ? `An empty ${name} block (its plugin may be inactive) would be removed.`
                  : `Existing ${name} at [${child.path.join(".")}] would be removed. Keep it with ${SOURCE_BLOCK} or list it in removedSourceBlocks.`,
                { blockName: name, ...(child.path ? { blockPath: child.path } : {}) }
              )
            );
          }
          return;
        }
        if (!preserved) visit(child, explicitly);
      });
    };
    visit(model.root, false);
  }

  function hasSourceDescendant(node) {
    return liveChildren(node).some(
      (child) =>
        child.kind === "source" ||
        child.kind === "hidden" ||
        hasSourceDescendant(child)
    );
  }

  function wrapperParts(text, span, label) {
    const children = span.children;
    const separator =
      children.length > 1 ? text.slice(children[0].end, children[1].start) : "\n\n";
    if (separator.trim() !== "") {
      throw new Error(
        `content_changed: the children of ${label} are separated by markup, so their order cannot change safely.`
      );
    }
    return {
      leading: text.slice(span.start, children[0].start),
      separator,
      trailing: text.slice(children[children.length - 1].end, span.end)
    };
  }

  function shellParts(rich) {
    const text = window.wp.blocks.serialize([rich]);
    const spans = tokenize(text);
    if (spans.length !== 1 || !spans[0].children.length) {
      throw new Error(
        `content_changed: WordPress did not render the nested blocks of ${rich.name}.`
      );
    }
    return wrapperParts(text, spans[0], rich.name);
  }

  function emit(model, node) {
    if (node.kind === "hidden" || (node.kind === "source" && node.state === "pristine")) {
      if (!node.span) {
        throw new Error(
          "content_changed: a block without a stored byte range cannot be written back."
        );
      }
      return model.content.slice(node.span.start, node.span.end);
    }
    const children = liveChildren(node);
    let parts;
    if (node.kind === "source") {
      parts =
        node.span && node.span.children.length
          ? wrapperParts(model.content, node.span, node.rich.name)
          : shellParts(richOf(node));
    } else if (!hasSourceDescendant(node)) {
      return window.wp.blocks.serialize([richOf(node)]);
    } else {
      parts = shellParts(richOf(node));
    }
    return (
      parts.leading +
      children.map((child) => emit(model, child)).join(parts.separator) +
      parts.trailing
    );
  }

  function serializeModel(model) {
    if (model.root.state === "pristine") return model.content;
    return liveChildren(model.root)
      .map((child) => emit(model, child))
      .join("\n\n");
  }

  // `kept` marks blocks v2 cannot author (and everything inside them). They
  // are written back unchanged, so native validity is their source's own.
  function collectInventory(
    nodes,
    capabilities = null,
    path = [],
    result = [],
    inside = false
  ) {
    nodes.forEach((node, index) => {
      const nodePath = [...path, index];
      const name = node.name || node.blockName;
      const kept =
        inside || (capabilities !== null && !authorableName(name, capabilities));
      result.push({
        name,
        path: nodePath,
        attributes: node.attributes || {},
        kept
      });
      collectInventory(
        node.innerBlocks || node.children || [],
        capabilities,
        nodePath,
        result,
        kept
      );
    });
    return result;
  }

  function validationAdapter(block) {
    if (block.isValid === false) {
      return false;
    }
    if (typeof window.wp.blocks.validateBlock !== "function") {
      return true;
    }
    try {
      const result = window.wp.blocks.validateBlock(
        block,
        window.wp.blocks.getBlockType(block.name)
      );
      return Array.isArray(result) ? result[0] !== false : result !== false;
    } catch {
      return false;
    }
  }

  function semanticProjection(nodes) {
    return nodes.map((node) => ({
      name: node.name || node.blockName,
      attributes: normalizedAttributes(
        node.name || node.blockName,
        node.attributes || {}
      ),
      children: semanticProjection(node.innerBlocks || node.children || [])
    }));
  }

  async function verifyInternal(
    serializedContent,
    expectedNodes,
    seedIssues = [],
    reportIntentHash = null,
    expectedCountOverride = null,
    capabilities = null
  ) {
    const issues = [...seedIssues];
    let observed = [];
    try {
      observed = window.wp.blocks.parse(serializedContent);
    } catch {
      issues.push(
        issue(
          "invalid_block_markup",
          "compile",
          "Serialized content could not be parsed.",
          { actual: serializedContent }
        )
      );
    }
    const expectedInventory = collectInventory(
      expectedNodes || [],
      capabilities
    );
    const expectedBlockCount = Number.isInteger(expectedCountOverride)
      ? expectedCountOverride
      : expectedInventory.length;
    const observedInventory = collectInventory(observed);
    if (expectedInventory.length > 0 && observedInventory.length === 0) {
      issues.push(
        issue(
          "missing_block",
          "compile",
          "A non-empty plan serialized to zero blocks."
        )
      );
    }
    observedInventory.forEach((entry, index) => {
      const block = locate(observed, entry.path);
      const keptEntry =
        expectedInventory[index] &&
        expectedInventory[index].kept &&
        expectedInventory[index].name === entry.name;
      if (keptEntry) {
        // Compared below by name and attributes only.
      } else if (entry.name === "core/missing") {
        issues.push(
          issue(
            "missing_block",
            "compile",
            "Gutenberg produced a missing block.",
            { blockPath: entry.path }
          )
        );
      } else if (entry.name === "core/freeform" || entry.name === "core/html") {
        issues.push(
          issue(
            "fallback_block",
            "compile",
            `Unexpected ${entry.name} fallback.`,
            { blockName: entry.name, blockPath: entry.path }
          )
        );
      } else if (block && !validationAdapter(block)) {
        issues.push(
          issue(
            "invalid_block_markup",
            "compile",
            `Block ${entry.name} failed Gutenberg validation.`,
            { blockName: entry.name, blockPath: entry.path }
          )
        );
      }
      const expected = expectedInventory[index];
      if (!expected) {
        issues.push(
          issue(
            "unexpected_block",
            "compile",
            `Unexpected block ${entry.name}.`,
            { blockName: entry.name, blockPath: entry.path }
          )
        );
      } else if (expected.name !== entry.name) {
        issues.push(
          issue(
            "content_changed",
            "compile",
            "Block type or ordering changed during serialization.",
            {
              blockName: entry.name,
              blockPath: entry.path,
              expected: expected.name,
              actual: entry.name
            }
          )
        );
      } else {
        const expectedAttributes = normalizedAttributes(
          expected.name,
          expected.attributes || {}
        );
        const observedAttributes = normalizedAttributes(
          entry.name,
          entry.attributes || {}
        );
        if (stableJson(expectedAttributes) !== stableJson(observedAttributes)) {
          issues.push(
            issue(
              "content_changed",
              "compile",
              `Attributes changed at ${entry.name} [${entry.path.join(".")}].`,
              {
                blockName: entry.name,
                blockPath: entry.path,
                expected: stableJson(expectedAttributes),
                actual: stableJson(observedAttributes)
              }
            )
          );
        }
      }
    });
    if (observedInventory.length < expectedBlockCount) {
      issues.push(
        issue(
          "missing_block",
          "compile",
          "Serialized output contains fewer blocks than intended.",
          { expected: expectedBlockCount, actual: observedInventory.length }
        )
      );
    }
    const semanticIntentHash = await sha256(
      semanticProjection(expectedNodes || [])
    );
    const semanticObservedHash = await sha256(semanticProjection(observed));
    if (semanticIntentHash !== semanticObservedHash) {
      issues.push(
        issue(
          "content_changed",
          "compile",
          "Attributes or nested content changed during the Gutenberg round trip.",
          { expected: semanticIntentHash, actual: semanticObservedHash }
        )
      );
    }
    const intentHash = reportIntentHash || semanticIntentHash;
    const preservationPassed =
      !issues.some((item) => item.severity === "error") &&
      semanticIntentHash === semanticObservedHash;
    const observedIntentHash = preservationPassed
      ? intentHash
      : semanticObservedHash;
    const boundedIssues = issues.slice(0, MAX_ISSUES);
    return {
      outcome: boundedIssues.some((item) => item.severity === "error")
        ? "invalid"
        : "valid",
      expectedBlockCount,
      observedBlockCount: observedInventory.length,
      issues: boundedIssues,
      contentPreservation: {
        passed: preservationPassed,
        checked: [
          "text",
          "inline_markup",
          "links",
          "media",
          "captions",
          "ordering",
          "layout"
        ],
        intentHash,
        observedIntentHash
      }
    };
  }

  function applyMediaMapping(plan, mediaMapping) {
    const byRef = new Map(
      (mediaMapping || []).map((entry) => [entry.ref, entry])
    );
    const mediaIntentByRef = new Map(
      (plan.media || []).map((entry) => [entry.ref, entry])
    );
    function mapNode(node) {
      const attributes = { ...(node.attributes || {}) };
      const mapping = attributes.mediaRef
        ? byRef.get(attributes.mediaRef)
        : null;
      const mediaIntent = attributes.mediaRef
        ? mediaIntentByRef.get(attributes.mediaRef)
        : null;
      if (mediaIntent && node.name === "core/media-text") {
        // v2 media intents are gated to raster images. Gutenberg requires this
        // derived attribute even before a final URL/attachment ID is bound;
        // otherwise its save implementation emits an empty figure and drops alt.
        attributes.mediaType = "image";
        if (
          !mapping &&
          mediaIntent.source &&
          /^[a-f0-9]{64}$/.test(mediaIntent.source.checksum || "")
        ) {
          attributes.mediaUrl = `https://sitepilot.invalid/staged/${mediaIntent.source.checksum}`;
        }
      }
      if (mediaIntent && node.name === "core/cover") {
        attributes.backgroundType = "image";
        if (
          !mapping &&
          mediaIntent.source &&
          /^[a-f0-9]{64}$/.test(mediaIntent.source.checksum || "")
        ) {
          attributes.url = `https://sitepilot.invalid/staged/${mediaIntent.source.checksum}`;
        }
      }
      if (mediaIntent && node.name === "core/video" && !mapping) {
        if (
          mediaIntent.source &&
          /^[a-f0-9]{64}$/.test(mediaIntent.source.checksum || "")
        ) {
          attributes.src = `https://sitepilot.invalid/staged/${mediaIntent.source.checksum}`;
        }
      }
      if (mapping && node.name === "core/video") {
        if (
          Number.isInteger(mapping.attachmentId) &&
          mapping.attachmentId > 0
        ) {
          attributes.id = mapping.attachmentId;
        }
        attributes.src = mapping.url;
      }
      if (mapping && node.name === "core/cover") {
        if (
          Number.isInteger(mapping.attachmentId) &&
          mapping.attachmentId > 0
        ) {
          attributes.id = mapping.attachmentId;
        }
        attributes.url = mapping.url;
      }
      if (mapping && node.name === "core/image") {
        if (
          Number.isInteger(mapping.attachmentId) &&
          mapping.attachmentId > 0
        ) {
          attributes.id = mapping.attachmentId;
        }
        attributes.url = mapping.url;
      } else if (mapping && node.name === "core/media-text") {
        if (
          Number.isInteger(mapping.attachmentId) &&
          mapping.attachmentId > 0
        ) {
          attributes.mediaId = mapping.attachmentId;
        }
        attributes.mediaUrl = mapping.url;
      }
      return {
        ...node,
        attributes,
        children: (node.children || []).map(mapNode)
      };
    }
    const mapped = { ...plan };
    if (Array.isArray(plan.blocks)) {
      mapped.blocks = plan.blocks.map(mapNode);
    }
    if (Array.isArray(plan.operations)) {
      mapped.operations = plan.operations.map((operation) => {
        if (operation.type === "insert_blocks") {
          return { ...operation, blocks: operation.blocks.map(mapNode) };
        }
        if (operation.type === "edit_block") {
          return { ...operation, replacement: mapNode(operation.replacement) };
        }
        return operation;
      });
    }
    return mapped;
  }

  async function buildPlan(plan, capabilities, issues, source) {
    if (
      plan &&
      (plan.operation === "apply_operations" ||
        plan.operation === "replace_content")
    ) {
      const model = await buildSourceModel(
        source && source.rawContent,
        capabilities,
        issues
      );
      if (!model) return { blocks: [], serializedContent: "" };
      if (plan.operation === "apply_operations") {
        applyOperations(model, plan, capabilities, issues);
      } else {
        replaceContent(model, plan, capabilities, issues);
      }
      if (!issues.length) checkContentLoss(model, plan, issues);
      const blocks = liveChildren(model.root).map(richOf).filter(Boolean);
      if (issues.length) return { blocks, serializedContent: "" };
      try {
        return { blocks, serializedContent: serializeModel(model) };
      } catch (error) {
        issues.push(
          issue(
            "content_changed",
            "compile",
            error && error.message ? error.message : "Content could not be written back."
          )
        );
        return { blocks, serializedContent: "" };
      }
    }
    if (plan && Array.isArray(plan.blocks)) {
      const blocks = plan.blocks
        .map((node, index) =>
          createNode(node, null, [], [index], capabilities, issues, 1)
        )
        .filter(Boolean);
      if (issues.length) return { blocks, serializedContent: "" };
      try {
        return { blocks, serializedContent: window.wp.blocks.serialize(blocks) };
      } catch (error) {
        issues.push(
          issue(
            "invalid_block_markup",
            "compile",
            error && error.message
              ? error.message
              : "Gutenberg serialization failed."
          )
        );
        return { blocks, serializedContent: "" };
      }
    }
    return { blocks: [], serializedContent: "" };
  }

  function planEmbedUrls(plan) {
    const urls = new Set();
    const visit = (nodes) => {
      (Array.isArray(nodes) ? nodes : []).forEach((node) => {
        if (!node || typeof node !== "object") return;
        if (
          node.name === "core/embed" &&
          node.attributes &&
          typeof node.attributes.url === "string"
        ) {
          urls.add(node.attributes.url);
        }
        visit(node.children);
      });
    };
    visit(plan && plan.blocks);
    ((plan && plan.operations) || []).forEach((operation) => {
      visit(operation && operation.blocks);
      if (operation && operation.replacement) visit([operation.replacement]);
    });
    return Array.from(urls);
  }

  // A video that is private, deleted or not embeddable must fail before
  // approval, not after the post is written.
  async function checkEmbeds(plan, issues) {
    const urls = planEmbedUrls(plan);
    if (!urls.length) return;
    if (typeof window.wp.apiFetch !== "function") {
      issues.push(
        issue(
          "editor_unavailable",
          "compile",
          "WordPress cannot check embedded videos in this editor."
        )
      );
      return;
    }
    for (const url of urls) {
      try {
        const response = await window.wp.apiFetch({
          path: `/oembed/1.0/proxy?url=${encodeURIComponent(url)}`
        });
        if (!response || typeof response.html !== "string" || !response.html) {
          throw new Error("WordPress returned no embed for it");
        }
      } catch (error) {
        issues.push(
          issue(
            "media_changed",
            "compile",
            `The video ${url} could not be embedded (${error && error.message ? error.message : "unavailable"}). Check it is public and the link is correct.`,
            { blockName: "core/embed" }
          )
        );
      }
    }
  }

  async function compile(input) {
    const originalPlan = input && input.plan ? input.plan : input;
    const plan = applyMediaMapping(
      originalPlan || {},
      input && input.plan ? input.mediaMapping : []
    );
    const source =
      input && input.plan && input.source ? input.source : config.source;
    const capabilities = await discover();
    if (
      config.expectedCapabilityFingerprint &&
      config.expectedCapabilityFingerprint !== capabilities.fingerprint
    ) {
      throw new Error(
        "runtime_changed: editor capability fingerprint changed."
      );
    }
    const issues = [];
    if (!plan || plan.schemaVersion !== "sitepilot.block-plan/v2") {
      issues.push(
        issue(
          "schema_invalid",
          "schema",
          "Expected a sitepilot.block-plan/v2 plan."
        )
      );
    }
    if (plan && plan.siteId !== config.siteId) {
      issues.push(
        issue(
          "permission_denied",
          "policy",
          "The plan site does not match this editor session."
        )
      );
    }
    if (
      plan &&
      plan.target &&
      plan.target.postType !== config.context.postType
    ) {
      issues.push(
        issue(
          "permission_denied",
          "policy",
          "The plan post type does not match this editor session."
        )
      );
    }
    if (
      plan &&
      plan.operation !== "create_draft" &&
      plan.target &&
      plan.target.postId !== config.context.postId
    ) {
      issues.push(
        issue(
          "stale_source",
          "policy",
          "The plan target does not match this editor session."
        )
      );
    }
    if (
      plan &&
      plan.operation !== "create_draft" &&
      plan.target &&
      plan.target.sourceContentHash !== source.contentHash
    ) {
      issues.push(
        issue(
          "stale_source",
          "compile",
          "The source content changed before compilation.",
          {
            expected: plan.target.sourceContentHash,
            actual: source.contentHash
          }
        )
      );
    }

    const built = await buildPlan(plan, capabilities, issues, source);
    const blocks = built.blocks;
    if (!issues.length) await checkEmbeds(plan, issues);
    if (countNodes(blocks) > MAX_BLOCKS) {
      issues.push(
        issue(
          "request_too_large",
          "schema",
          "The compiled tree exceeds the v2 block limit."
        )
      );
    }
    const serializedContent = issues.length ? "" : built.serializedContent;
    const fullIntentHash = await sha256(originalPlan || {});
    const requestedCount =
      plan &&
      plan.operation === "create_draft" &&
      Array.isArray(plan.blocks)
        ? countNodes(plan.blocks)
        : null;
    const validation = await verifyInternal(
      serializedContent,
      blocks,
      issues,
      fullIntentHash,
      requestedCount,
      capabilities
    );
    return {
      schemaVersion: "sitepilot.editor-compile-result/v2",
      planId: plan && plan.planId ? plan.planId : "",
      operation: plan && plan.operation ? plan.operation : "create_draft",
      serializedContent,
      contentHash: await sha256(serializedContent),
      intentHash: fullIntentHash,
      capabilityFingerprint: capabilities.fingerprint,
      validation,
      compiledAt: new Date().toISOString()
    };
  }

  async function verify(input) {
    if (
      !input ||
      typeof input.serializedContent !== "string" ||
      typeof input.expectedSerializedContent !== "string"
    ) {
      throw new Error(
        "schema_invalid: serializedContent and expectedSerializedContent are required."
      );
    }
    const capabilities = await discover();
    const issues = [];
    let expected = [];
    try {
      expected = window.wp.blocks.parse(input.expectedSerializedContent);
    } catch {
      issues.push(
        issue(
          "invalid_block_markup",
          "verify",
          "Expected serialized content could not be parsed."
        )
      );
    }
    return verifyInternal(
      input.serializedContent,
      expected,
      issues,
      await sha256(input.intent || {}),
      null,
      capabilities
    );
  }

  async function preview(input) {
    if (
      !input ||
      typeof input.serializedContent !== "string" ||
      !input.intent ||
      typeof input.intent !== "object" ||
      !["desktop", "mobile"].includes(input.viewport)
    ) {
      throw new Error(
        "schema_invalid: preview content, intent, and viewport are required."
      );
    }
    const capabilities = await discover();
    const issues = [];
    const basePlan = applyMediaMapping(
      input.intent,
      Array.isArray(input.mediaMapping) ? input.mediaMapping : []
    );
    const base = await buildPlan(basePlan, capabilities, issues, config.source);
    const baseBlocks = base.blocks;
    const reconstructed = base.serializedContent;
    if (issues.length) {
      issues.push(
        issue(
          "invalid_block_markup",
          "verify",
          "Preview intent could not be reconstructed."
        )
      );
    }
    if (
      (await sha256(reconstructed)) !== (await sha256(input.serializedContent))
    ) {
      issues.push(
        issue(
          "content_changed",
          "verify",
          "Preview intent does not reconstruct the approved content bytes."
        )
      );
    }
    const validation = await verifyInternal(
      input.serializedContent,
      baseBlocks,
      issues,
      await sha256(input.intent || {}),
      null,
      capabilities
    );
    if (validation.outcome !== "valid") {
      throw new Error(
        `persisted_content_invalid: ${validation.issues[0] ? validation.issues[0].message : "preview content failed validation."}`
      );
    }
    const previewMapping = Array.isArray(input.previewMediaMapping)
      ? input.previewMediaMapping
      : [];
    const approvedMedia = new Map(
      (input.intent.media || []).map((media) => [
        media.ref,
        media.source.checksum
      ])
    );
    if (
      previewMapping.length !== approvedMedia.size ||
      new Set(previewMapping.map((mapping) => mapping.ref)).size !==
        previewMapping.length
    ) {
      throw new Error(
        "media_changed: preview media does not cover the approved intent exactly."
      );
    }
    let previewBytes = 0;
    for (const mapping of previewMapping) {
      const encoded = String(mapping.dataUrl || "").split(",", 2)[1] || "";
      let binary;
      try {
        binary = window.atob(encoded);
      } catch {
        throw new Error("media_changed: preview media is not valid base64.");
      }
      const bytes = Uint8Array.from(binary, (character) =>
        character.charCodeAt(0)
      );
      previewBytes += bytes.byteLength;
      if (
        previewBytes > 25000000 ||
        approvedMedia.get(mapping.ref) !== mapping.approvedChecksum ||
        (await sha256Bytes(bytes)) !== mapping.approvedChecksum
      ) {
        throw new Error("media_changed: preview media changed after approval.");
      }
    }
    let blocks = baseBlocks;
    if (previewMapping.length) {
      const finalMediaByRef = new Map(
        (input.mediaMapping || []).map((mapping) => [mapping.ref, mapping])
      );
      const previewPlan = applyMediaMapping(
        input.intent,
        previewMapping.map((mapping) => {
          const finalMedia = finalMediaByRef.get(mapping.ref);
          return {
            ref: mapping.ref,
            ...(finalMedia && Number.isInteger(finalMedia.attachmentId)
              ? { attachmentId: finalMedia.attachmentId }
              : {}),
            url: mapping.dataUrl
          };
        })
      );
      const previewIssues = [];
      blocks = (
        await buildPlan(previewPlan, capabilities, previewIssues, config.source)
      ).blocks;
      if (previewIssues.some((item) => item.severity === "error")) {
        throw new Error(`media_changed: ${previewIssues[0].message}`);
      }
    }
    const dispatcher = window.wp.data.dispatch("core/block-editor");
    if (!dispatcher || typeof dispatcher.resetBlocks !== "function") {
      throw new Error(
        "editor_unavailable: native block rendering is unavailable."
      );
    }
    dispatcher.resetBlocks(blocks);
    const editorDispatcher = window.wp.data.dispatch("core/editor");
    const sourceFields = (config.source && config.source.fields) || {};
    const requestedFields =
      input.intent && input.intent.postFields ? input.intent.postFields : {};
    if (editorDispatcher && typeof editorDispatcher.editPost === "function") {
      editorDispatcher.editPost({
        title:
          requestedFields.title === undefined
            ? sourceFields.title || ""
            : requestedFields.title,
        excerpt:
          requestedFields.excerpt === undefined
            ? sourceFields.excerpt || ""
            : requestedFields.excerpt
      });
    }
    const deadline = Date.now() + 5000;
    let root = null;
    while (Date.now() < deadline && !root) {
      root = document.querySelector(
        'iframe[name="editor-canvas"], iframe.editor-canvas__iframe, .editor-styles-wrapper, .block-editor-block-list__layout'
      );
      if (!root) {
        await new Promise((resolve) => window.setTimeout(resolve, 50));
      }
    }
    if (!root) {
      throw new Error(
        "editor_unavailable: native editor canvas did not render."
      );
    }
    root.id = "sitepilot-v2-preview";
    await new Promise((resolve) =>
      window.requestAnimationFrame(() => window.requestAnimationFrame(resolve))
    );
    let imageRoot = root;
    if (root.tagName === "IFRAME") {
      try {
        imageRoot = root.contentDocument || root;
      } catch {
        imageRoot = root;
      }
    }
    const images = Array.from(
      imageRoot.querySelectorAll ? imageRoot.querySelectorAll("img") : []
    );
    await Promise.all(
      images.map((image) =>
        image.complete
          ? Promise.resolve()
          : new Promise((resolve) => {
              const timeout = window.setTimeout(resolve, 3000);
              image.addEventListener(
                "load",
                () => {
                  window.clearTimeout(timeout);
                  resolve();
                },
                { once: true }
              );
              image.addEventListener(
                "error",
                () => {
                  window.clearTimeout(timeout);
                  resolve();
                },
                { once: true }
              );
            })
      )
    );
    // Only media placed in blocks renders in the canvas; a featured image
    // (postFields.featuredMediaRef) is not part of the content.
    const renderedRefs = blockMediaRefs(input.intent);
    const videos = Array.from(
      imageRoot.querySelectorAll ? imageRoot.querySelectorAll("video") : []
    );
    for (const mapping of previewMapping) {
      if (!renderedRefs.has(mapping.ref)) continue;
      if (/^data:video\//.test(mapping.dataUrl)) {
        // Headless browsers often cannot decode video, so the preview only
        // proves the approved bytes are placed in a native video element.
        const placed = videos.some(
          (video) =>
            video.getAttribute("src") === mapping.dataUrl ||
            video.src === mapping.dataUrl
        );
        if (!placed) {
          throw new Error(
            `media_changed: preview video ${mapping.ref} was not placed.`
          );
        }
        continue;
      }
      const renderedImage = images.find(
        (candidate) =>
          candidate.getAttribute("src") === mapping.dataUrl ||
          candidate.src === mapping.dataUrl
      );
      if (
        !renderedImage ||
        !renderedImage.complete ||
        renderedImage.naturalWidth < 1
      ) {
        throw new Error(
          `media_changed: preview image ${mapping.ref} did not load.`
        );
      }
    }
    await settledLayout(imageRoot, blocks);
    return {
      schemaVersion: "sitepilot.editor-preview-result/v2",
      renderedContentHash: await sha256(input.serializedContent),
      previewMediaManifestHash: await sha256(
        previewMapping
          .map((mapping) => ({
            ref: mapping.ref,
            approvedChecksum: mapping.approvedChecksum
          }))
          .sort((left, right) =>
            left.ref < right.ref ? -1 : left.ref > right.ref ? 1 : 0
          )
      ),
      rootSelector: "#sitepilot-v2-preview"
    };
  }

  function containsAcfBlock(blocks) {
    return blocks.some(
      (block) =>
        ACF_BLOCKS.has(block.name) || containsAcfBlock(block.innerBlocks || [])
    );
  }

  // ACF blocks render their preview from the server after they mount, so
  // the canvas keeps changing size for a moment. Wait (bounded) until it
  // stops, so the review capture measures the finished layout.
  async function settledLayout(root, blocks) {
    if (!containsAcfBlock(blocks)) return;
    const measure = () => {
      const target = root && root.body ? root.body : root;
      return target && typeof target.scrollHeight === "number"
        ? target.scrollHeight
        : 0;
    };
    const loading = () =>
      !!(
        root &&
        root.querySelector &&
        root.querySelector(
          ".acf-block-preview .acf-loading, .acf-block-component .components-spinner, .acf-block-preview:empty"
        )
      );
    const started = Date.now();
    let last = measure();
    let stableSince = Date.now();
    while (Date.now() - started < 10000) {
      await new Promise((resolve) => window.setTimeout(resolve, 200));
      const current = measure();
      if (current !== last || loading()) {
        last = current;
        stableSince = Date.now();
      } else if (Date.now() - stableSince >= 1000) {
        return;
      }
    }
  }

  async function readSource() {
    const source = JSON.parse(JSON.stringify(config.source));
    let blocks;
    try {
      blocks = window.wp.blocks.parse(source.rawContent || "");
    } catch {
      throw new Error(
        "invalid_block_markup: source content could not be parsed."
      );
    }
    if (countNodes(blocks) > MAX_BLOCKS) {
      throw new Error(
        "request_too_large: source content exceeds the v2 block limit."
      );
    }
    const capabilities = await discover();
    const blockIndex = [];
    async function indexNodes(nodes, path = [], inside = false) {
      for (let index = 0; index < nodes.length; index++) {
        const node = nodes[index];
        const nodePath = [...path, index];
        const authorable = authorableName(node.name, capabilities);
        const role = inside
          ? "inside_preserved"
          : authorable
            ? "authorable"
            : "preserved";
        const summary = role === "preserved" ? textSummary(node) : "";
        blockIndex.push({
          path: nodePath,
          name: node.name,
          fingerprint: await nodeFingerprint(node),
          role,
          ...(summary ? { summary } : {})
        });
        await indexNodes(
          node.innerBlocks || [],
          nodePath,
          inside || !authorable
        );
      }
    }
    await indexNodes(blocks);
    return {
      ...source,
      blockTreeFingerprint: await sha256(blocks.map(parsedNodeShape)),
      blockIndex
    };
  }

  let readyPromise;
  function ready() {
    if (!readyPromise) {
      readyPromise = discover().then((snapshot) => {
        if (
          config.expectedCapabilityFingerprint &&
          config.expectedCapabilityFingerprint !== snapshot.fingerprint
        ) {
          throw new Error(
            "runtime_changed: editor capability fingerprint changed."
          );
        }
        return snapshot;
      });
    }
    return readyPromise;
  }

  function nativeIssues(blocks, path = []) {
    const found = [];
    blocks.forEach((block, index) => {
      const blockPath = [...path, index];
      if (block.name === "core/missing" || block.name === "core/freeform") {
        found.push(
          issue(
            "fallback_block",
            "verify",
            `The saved markup reopened as ${block.name}.`,
            {
              blockName: block.name,
              blockPath
            }
          )
        );
      } else if (!validationAdapter(block)) {
        found.push(
          issue(
            "invalid_block_markup",
            "verify",
            `Block ${block.name} failed Gutenberg validation when reopened.`,
            {
              blockName: block.name,
              blockPath
            }
          )
        );
      }
      found.push(...nativeIssues(block.innerBlocks || [], blockPath));
    });
    return found;
  }

  async function settledContent(minimumMs, maximumMs) {
    const select = window.wp.data.select("core/block-editor");
    const started = Date.now();
    let last = window.wp.blocks.serialize(select.getBlocks());
    let stableSince = Date.now();
    while (Date.now() - started < maximumMs) {
      await new Promise((resolve) => window.setTimeout(resolve, 250));
      const current = window.wp.blocks.serialize(select.getBlocks());
      if (current !== last) {
        last = current;
        stableSince = Date.now();
      } else if (
        Date.now() - started >= minimumMs &&
        Date.now() - stableSince >= 1000
      ) {
        break;
      }
    }
    return last;
  }

  // Per-site ACF fixture. Builds the block natively with the given data,
  // serializes it as a save would, then reopens the saved markup in this
  // editor so the block's own scripts run on it. The block passes only if
  // it reopens valid and serializes back to the same bytes. The plugin
  // repeats the save, data and render checks on the server before
  // recording the result.
  async function blockFixture(input) {
    await discover();
    const name =
      input && typeof input.blockName === "string" ? input.blockName : "";
    const definition = ACF_BLOCKS.get(name);
    const issues = [];
    const result = (serializedContent = "", reopenedContent = "") => ({
      schemaVersion: "sitepilot.block-fixture-result/v2",
      blockName: name,
      schemaHash: definition ? definition.schemaHash : "",
      serializedContent,
      reopenedContent,
      issues: issues.slice(0, MAX_ISSUES)
    });
    if (!definition || !window.wp.blocks.getBlockType(name)) {
      issues.push(
        issue(
          "unregistered_block",
          "policy",
          `${name || "The block"} is not an ACF block registered in this editor.`,
          {
            blockName: name
          }
        )
      );
      return result();
    }
    const data =
      input && input.data && typeof input.data === "object" ? input.data : {};
    let saved = "";
    try {
      const children = definition.innerBlocks
        ? [
            window.wp.blocks.createBlock("core/paragraph", {
              content: "SitePilot block test."
            })
          ]
        : [];
      const block = window.wp.blocks.createBlock(
        name,
        {
          name,
          data,
          align:
            typeof definition.defaultAlign === "string"
              ? definition.defaultAlign
              : "",
          mode: definition.mode || "preview"
        },
        children
      );
      saved = window.wp.blocks.serialize([block]);
    } catch (error) {
      issues.push(
        issue(
          "invalid_block_markup",
          "compile",
          error && error.message
            ? error.message
            : "The block could not be built.",
          {
            blockName: name
          }
        )
      );
      return result();
    }
    let parsed = [];
    try {
      parsed = window.wp.blocks.parse(saved);
    } catch {
      issues.push(
        issue(
          "invalid_block_markup",
          "verify",
          "The saved markup could not be parsed.",
          { blockName: name }
        )
      );
      return result(saved);
    }
    issues.push(...nativeIssues(parsed));
    if (parsed.length !== 1 || parsed[0].name !== name) {
      issues.push(
        issue(
          "unexpected_block",
          "verify",
          `The saved markup did not reopen as one ${name} block.`,
          { blockName: name }
        )
      );
    }
    if (issues.length) return result(saved);
    const dispatch = window.wp.data.dispatch("core/block-editor");
    dispatch.resetBlocks(parsed);
    const reopened = await settledContent(1500, 8000);
    const reopenedBlocks = window.wp.data
      .select("core/block-editor")
      .getBlocks();
    issues.push(...nativeIssues(reopenedBlocks));
    const reopenedData =
      reopenedBlocks[0] && reopenedBlocks[0].attributes
        ? reopenedBlocks[0].attributes.data
        : undefined;
    if (stableJson(reopenedData || {}) !== stableJson(data)) {
      issues.push(
        issue(
          "content_changed",
          "verify",
          `The editor changed ${name} field values when it reopened the block.`,
          {
            blockName: name,
            expected: stableJson(data),
            actual: stableJson(reopenedData || {})
          }
        )
      );
    }
    dispatch.resetBlocks([]);
    return result(saved, reopened);
  }

  window.sitepilotV2 = Object.freeze({
    schemaVersion: "sitepilot.editor-bridge/v2",
    ready,
    discover,
    compile,
    verify,
    preview,
    readSource,
    blockFixture
  });
})();
