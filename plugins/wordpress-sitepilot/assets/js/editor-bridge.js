/* global window, document, TextEncoder */
(function () {
  "use strict";

  const config = window.sitepilotV2Config || {};
  const AUTHOR_BLOCKS = new Set([
    "core/paragraph",
    "core/heading",
    "core/group",
    "core/columns",
    "core/column",
    "core/image",
    "core/list",
    "core/list-item",
    "core/buttons",
    "core/button",
    "core/quote",
    "core/spacer",
    "core/table",
    "core/pullquote",
    "core/media-text"
  ]);
  const FIXTURE_REQUIRED_BLOCKS = new Set([
    "core/latest-posts",
    "acf/container"
  ]);
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

  function supportMode(name) {
    if (AUTHOR_BLOCKS.has(name)) {
      return "author";
    }
    if (FIXTURE_REQUIRED_BLOCKS.has(name)) {
      return "unsupported";
    }
    return "unsupported";
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
        v2Support: supportMode(name),
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
        lock: contextLock
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
      if (richText && typeof richText.toHTMLString === "function") {
        if (typeof value === "string") {
          if (typeof richText.create !== "function") {
            throw new Error(
              `WordPress cannot normalize rich-text input for ${blockName}.${attributePath}.`
            );
          }
          return richText.toHTMLString({
            value: richText.create({ html: value })
          });
        }
        return richText.toHTMLString({ value });
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
    depth
  ) {
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
    if (capability.v2Support !== "author") {
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
    const children = (node.children || [])
      .map((child, index) =>
        createNode(
          child,
          node.name,
          childAncestors,
          [...path, index],
          capabilities,
          issues,
          depth + 1
        )
      )
      .filter(Boolean);
    if (children.length !== (node.children || []).length) {
      return null;
    }
    try {
      const requestedAttributes = normalizedAttributes(
        node.name,
        cleanAttributes(node)
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

  function locateParent(roots, path) {
    if (path.length === 0) {
      return { siblings: roots, index: -1 };
    }
    const parent = path.length === 1 ? null : locate(roots, path.slice(0, -1));
    return {
      siblings: parent ? parent.innerBlocks : roots,
      index: path[path.length - 1]
    };
  }

  function ancestorsForPath(roots, path) {
    const ancestors = [];
    let siblings = roots;
    for (const index of path.slice(0, -1)) {
      const node = siblings[index];
      if (!node) {
        return [];
      }
      ancestors.push(node.name);
      siblings = node.innerBlocks || [];
    }
    return ancestors;
  }

  function hasBoundOrLockedAttributes(attributes) {
    const lock = attributes && attributes.lock;
    const bindings =
      attributes && attributes.metadata && attributes.metadata.bindings;
    return (
      !!(lock && Object.values(lock).some(Boolean)) ||
      !!(bindings && Object.keys(bindings).length)
    );
  }

  function validateExistingTree(
    nodes,
    capabilities,
    issues,
    path = [],
    depth = 1,
    parentName = null,
    ancestors = []
  ) {
    if (nodes.length === 0) {
      return true;
    }
    if (depth > MAX_DEPTH) {
      issues.push(
        issue(
          "invalid_nesting",
          "policy",
          "Existing content exceeds the v2 nesting limit.",
          { blockPath: path }
        )
      );
      return false;
    }
    let valid = true;
    nodes.forEach((node, index) => {
      const nodePath = [...path, index];
      const capability = capabilities.blocks.find(
        (block) => block.name === node.name
      );
      const parentCapability = parentName
        ? capabilities.blocks.find((block) => block.name === parentName)
        : null;
      if (
        node.name === "core/missing" ||
        node.name === "core/freeform" ||
        node.name === "core/html"
      ) {
        issues.push(
          issue(
            node.name === "core/missing" ? "missing_block" : "fallback_block",
            "policy",
            `Existing ${node.name} content cannot be safely edited.`,
            { blockName: node.name, blockPath: nodePath }
          )
        );
        valid = false;
      } else if (containsSerializedBlockDelimiter(node.attributes || {})) {
        issues.push(
          issue(
            "invalid_block_markup",
            "policy",
            "Existing rich text contains serialized Gutenberg block delimiters.",
            { blockName: node.name, blockPath: nodePath }
          )
        );
        valid = false;
      } else if (!capability || !capability.registered) {
        issues.push(
          issue(
            "unregistered_block",
            "policy",
            `Existing block ${node.name} is not registered.`,
            { blockName: node.name, blockPath: nodePath }
          )
        );
        valid = false;
      } else if (!capability.allowed || capability.v2Support !== "author") {
        issues.push(
          issue(
            "unsupported_v2_block",
            "policy",
            `Existing block ${node.name} has not passed the v2 fixture gate.`,
            { blockName: node.name, blockPath: nodePath }
          )
        );
        valid = false;
      } else if (
        capability.lock !== "none" ||
        (capability.allowedParents.length &&
          (!parentName || !capability.allowedParents.includes(parentName))) ||
        (capability.allowedAncestors.length &&
          !ancestors.some((name) =>
            capability.allowedAncestors.includes(name)
          )) ||
        (parentCapability &&
          parentCapability.allowedChildren.length &&
          !parentCapability.allowedChildren.includes(node.name))
      ) {
        issues.push(
          issue(
            capability.lock !== "none" ? "locked_structure" : "invalid_nesting",
            "policy",
            `Existing block ${node.name} cannot be edited in this context.`,
            { blockName: node.name, blockPath: nodePath }
          )
        );
        valid = false;
      } else if (!validationAdapter(node)) {
        issues.push(
          issue(
            "invalid_block_markup",
            "policy",
            `Existing block ${node.name} is invalid.`,
            { blockName: node.name, blockPath: nodePath }
          )
        );
        valid = false;
      }
      if (
        node.name === "core/block" ||
        (node.attributes &&
          Object.prototype.hasOwnProperty.call(node.attributes, "ref")) ||
        hasBoundOrLockedAttributes(node.attributes || {})
      ) {
        issues.push(
          issue(
            "locked_structure",
            "policy",
            `Existing block ${node.name} is locked, bound, or referenced.`,
            { blockName: node.name, blockPath: nodePath }
          )
        );
        valid = false;
      }
      const childAncestors = [...ancestors, node.name];
      if (
        !validateExistingTree(
          node.innerBlocks || [],
          capabilities,
          issues,
          nodePath,
          depth + 1,
          node.name,
          childAncestors
        )
      ) {
        valid = false;
      }
    });
    return valid;
  }

  async function applyOperations(plan, capabilities, issues, source) {
    let roots;
    try {
      roots = window.wp.blocks.parse((source && source.rawContent) || "");
    } catch {
      issues.push(
        issue(
          "invalid_block_markup",
          "compile",
          "The source content cannot be parsed."
        )
      );
      return [];
    }
    if (countNodes(roots) > MAX_BLOCKS) {
      issues.push(
        issue(
          "request_too_large",
          "schema",
          "Existing content exceeds the v2 block limit."
        )
      );
      return [];
    }
    if (!validateExistingTree(roots, capabilities, issues)) {
      return [];
    }
    for (const operation of plan.operations) {
      const target =
        operation.type === "insert_blocks"
          ? operation.parent
          : operation.target;
      const targetNode = target.path.length ? locate(roots, target.path) : null;
      const targetValue = targetNode
        ? await nodeFingerprint(targetNode)
        : await sha256(roots.map(parsedNodeShape));
      if (targetValue !== target.expectedFingerprint) {
        issues.push(
          issue(
            "stale_source",
            "compile",
            `Operation ${operation.id} target fingerprint changed.`,
            {
              blockPath: target.path,
              expected: target.expectedFingerprint,
              actual: targetValue
            }
          )
        );
        continue;
      }
      if (operation.type === "insert_blocks") {
        const siblings = targetNode ? targetNode.innerBlocks : roots;
        if (operation.index > siblings.length) {
          issues.push(
            issue(
              "invalid_nesting",
              "compile",
              `Operation ${operation.id} insertion index is out of range.`,
              { blockPath: target.path }
            )
          );
          continue;
        }
        const targetAncestors = targetNode
          ? [...ancestorsForPath(roots, target.path), targetNode.name]
          : [];
        const additions = operation.blocks
          .map((node, index) =>
            createNode(
              node,
              targetNode && targetNode.name,
              targetAncestors,
              [...target.path, operation.index + index],
              capabilities,
              issues,
              target.path.length + 1
            )
          )
          .filter(Boolean);
        if (additions.length === operation.blocks.length) {
          siblings.splice(operation.index, 0, ...additions);
        }
      } else {
        const parent = locateParent(roots, target.path);
        if (!parent.siblings || parent.index < 0) {
          issues.push(
            issue(
              "invalid_nesting",
              "compile",
              `Operation ${operation.id} target path is invalid.`,
              { blockPath: target.path }
            )
          );
          continue;
        }
        if (operation.type === "remove_block") {
          parent.siblings.splice(parent.index, 1);
        } else {
          const ancestors = ancestorsForPath(roots, target.path);
          const parentName = ancestors.length
            ? ancestors[ancestors.length - 1]
            : null;
          const replacement = createNode(
            operation.replacement,
            parentName,
            ancestors.slice(0, -1),
            target.path,
            capabilities,
            issues,
            target.path.length
          );
          if (replacement) {
            parent.siblings.splice(parent.index, 1, replacement);
          }
        }
      }
    }
    return roots;
  }

  function collectInventory(nodes, path = [], result = []) {
    nodes.forEach((node, index) => {
      const nodePath = [...path, index];
      result.push({
        name: node.name || node.blockName,
        path: nodePath,
        attributes: node.attributes || {}
      });
      collectInventory(
        node.innerBlocks || node.children || [],
        nodePath,
        result
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
    expectedCountOverride = null
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
    const expectedInventory = collectInventory(expectedNodes || []);
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
      if (entry.name === "core/missing") {
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

  async function buildPlanBlocks(plan, capabilities, issues, source) {
    if (plan && plan.operation === "apply_operations") {
      return applyOperations(plan, capabilities, issues, source);
    }
    if (plan && Array.isArray(plan.blocks)) {
      return plan.blocks
        .map((node, index) =>
          createNode(node, null, [], [index], capabilities, issues, 1)
        )
        .filter(Boolean);
    }
    return [];
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

    const blocks = await buildPlanBlocks(plan, capabilities, issues, source);
    if (countNodes(blocks) > MAX_BLOCKS) {
      issues.push(
        issue(
          "request_too_large",
          "schema",
          "The compiled tree exceeds the v2 block limit."
        )
      );
    }
    let serializedContent = "";
    if (!issues.length) {
      try {
        serializedContent = window.wp.blocks.serialize(blocks);
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
      }
    }
    const fullIntentHash = await sha256(originalPlan || {});
    const requestedCount =
      plan &&
      plan.operation !== "apply_operations" &&
      Array.isArray(plan.blocks)
        ? countNodes(plan.blocks)
        : null;
    const validation = await verifyInternal(
      serializedContent,
      blocks,
      issues,
      fullIntentHash,
      requestedCount
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
    if (!validateExistingTree(expected, capabilities, issues)) {
      // validateExistingTree records exact native validation and policy failures.
    }
    return verifyInternal(
      input.serializedContent,
      expected,
      issues,
      await sha256(input.intent || {})
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
    const baseBlocks = await buildPlanBlocks(
      basePlan,
      capabilities,
      issues,
      config.source
    );
    let reconstructed = "";
    try {
      reconstructed = window.wp.blocks.serialize(baseBlocks);
    } catch {
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
      await sha256(input.intent || {})
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
      blocks = await buildPlanBlocks(
        previewPlan,
        capabilities,
        previewIssues,
        config.source
      );
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
    for (const mapping of previewMapping) {
      if (!renderedRefs.has(mapping.ref)) continue;
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
    const blockIndex = [];
    async function indexNodes(nodes, path = []) {
      for (let index = 0; index < nodes.length; index++) {
        const node = nodes[index];
        const nodePath = [...path, index];
        blockIndex.push({
          path: nodePath,
          name: node.name,
          fingerprint: await nodeFingerprint(node)
        });
        await indexNodes(node.innerBlocks || [], nodePath);
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

  window.sitepilotV2 = Object.freeze({
    schemaVersion: "sitepilot.editor-bridge/v2",
    ready,
    discover,
    compile,
    verify,
    preview,
    readSource
  });
})();
