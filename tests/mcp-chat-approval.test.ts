import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  createSitePilotMcpServer,
  type McpCaller,
  type McpRequestStatus,
  type SitePilotMcpBackend
} from "@sitepilot/mcp-server";
import { describe, expect, it, vi } from "vitest";

import { createReviewLinks } from "../apps/server/src/review-links.js";

/**
 * Approving from a chat app: only the person's answer in the app's prompt, or
 * their click on the review card, approves. The model can't.
 */

const AWAITING: McpRequestStatus = {
  requestId: "thread-1",
  siteId: "site-1",
  title: "New post: Lake District weekend",
  state: "awaiting_approval",
  summary: "Ready.",
  recentMessages: [],
  updatedAt: "2026-10-01T12:00:00.000Z",
  changes: { operation: "create_draft", title: "A Weekend in the Lake District" },
  reviewArtifacts: [
    { id: "preview-0", kind: "preview", url: "https://sitepilot.example/r/desktop" },
    { id: "preview-1", kind: "preview", url: "https://sitepilot.example/r/mobile" }
  ]
};

const PUBLISHER = { userProfileId: "wp-site-1-42", appRole: "approver", siteRoles: ["request", "approve"] };

function approvalBackend() {
  return {
    listSites: vi.fn(async () => [{ siteId: "site-1", name: "Site one", baseUrl: "https://one.test" }]),
    lookup: vi.fn(),
    createConversation: vi.fn(),
    ask: vi.fn(),
    createRequest: vi.fn(),
    addToRequest: vi.fn(),
    requestStatus: vi.fn(async () => ({ ok: true as const, status: AWAITING })),
    listThreads: vi.fn(),
    getReviewArtifact: vi.fn(),
    approvalSubject: vi.fn(async () => ({ ok: true as const, candidateId: "candidate-7", status: AWAITING })),
    decideForPerson: vi.fn(async () => ({ ok: true as const, status: { ...AWAITING, state: "approved" as const } }))
  } satisfies Partial<SitePilotMcpBackend>;
}

async function connect(
  backend: ReturnType<typeof approvalBackend>,
  caller: McpCaller,
  answer?: (message: string) => { action: "accept" | "decline" | "cancel"; content?: Record<string, string> }
) {
  const server = createSitePilotMcpServer({
    backend: backend as unknown as SitePilotMcpBackend,
    version: "test",
    caller: () => caller,
    reviewCard: { resourceDomains: ["https://sitepilot.example"] }
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client(
    { name: "codex", version: "1.0.0" },
    answer ? { capabilities: { elicitation: {} } } : {}
  );
  if (answer) client.setRequestHandler(ElicitRequestSchema, async (request) => answer(request.params.message));
  await client.connect(clientTransport);
  return client;
}

const text = (result: Awaited<ReturnType<Client["callTool"]>>) =>
  (result.content as Array<{ text?: string }>).map((part) => part.text ?? "").join("\n");

describe("approving from a chat app", () => {
  it("approves only when the person answers the app's prompt, and applies", async () => {
    const backend = approvalBackend();
    let shown = "";
    const client = await connect(backend, { clientName: "codex", actor: PUBLISHER }, (message) => {
      shown = message;
      return { action: "accept", content: { decision: "approve" } };
    });
    const result = await client.callTool({ name: "ask_to_approve", arguments: { request_id: "thread-1" } });
    expect(result.isError).toBeFalsy();
    expect(shown).toContain("A Weekend in the Lake District");
    expect(shown).toContain("Desktop preview: https://sitepilot.example/r/desktop");
    expect(text(result)).toContain("The person approved it");
    expect(backend.decideForPerson).toHaveBeenCalledWith(
      expect.objectContaining({ candidateId: "candidate-7", decision: "approve", channel: "approval_prompt" }),
      expect.anything()
    );
  });

  it("changes nothing when the person declines, and refuses apps that can't ask", async () => {
    const backend = approvalBackend();
    const declining = await connect(backend, { actor: PUBLISHER }, () => ({ action: "decline" }));
    const declined = await declining.callTool({ name: "ask_to_approve", arguments: { request_id: "thread-1" } });
    expect(text(declined)).toContain("didn't approve");

    const noPrompts = await connect(backend, { actor: PUBLISHER });
    const refused = await noPrompts.callTool({ name: "ask_to_approve", arguments: { request_id: "thread-1" } });
    expect(refused.structuredContent).toMatchObject({ code: "approval_prompt_unsupported" });
    expect(backend.decideForPerson).not.toHaveBeenCalled();

    // Without the approve scope, the prompt never appears.
    const scoped = await connect(backend, { actor: PUBLISHER, scopes: ["read", "review"] }, () => ({
      action: "accept",
      content: { decision: "approve" }
    }));
    const unscoped = await scoped.callTool({ name: "ask_to_approve", arguments: { request_id: "thread-1" } });
    expect(unscoped.structuredContent).toMatchObject({ code: "forbidden" });
    expect(backend.decideForPerson).not.toHaveBeenCalled();
  });

  it("gives the review card a one-use ticket that only its person can use", async () => {
    const backend = approvalBackend();
    const client = await connect(backend, { clientName: "claude.ai", actor: PUBLISHER });
    const { tools } = await client.listTools();
    const cardTool = tools.find((tool) => tool.name === "decide_from_card");
    expect((cardTool?._meta as { ui?: { visibility?: string[] } })?.ui?.visibility).toEqual(["app"]);

    const shown = await client.callTool({ name: "show_review", arguments: { request_id: "thread-1" } });
    expect(shown.structuredContent).toMatchObject({
      title: AWAITING.title,
      previews: [
        { label: "Desktop", url: "https://sitepilot.example/r/desktop" },
        { label: "Mobile", url: "https://sitepilot.example/r/mobile" }
      ]
    });
    const ticket = (shown._meta as Record<string, { ticket: string }>)["sitepilot/approval"]?.ticket ?? "";
    expect(ticket.length).toBeGreaterThan(16);
    expect(text(shown)).not.toContain(ticket);

    const guessed = await client.callTool({
      name: "decide_from_card",
      arguments: { request_id: "thread-1", ticket: "not-the-ticket-at-all-123", decision: "approve" }
    });
    expect(guessed.structuredContent).toMatchObject({ code: "approval_ticket_invalid" });

    const someoneElse = await connect(backend, { actor: { ...PUBLISHER, userProfileId: "wp-site-1-7" } });
    const stolen = await someoneElse.callTool({
      name: "decide_from_card",
      arguments: { request_id: "thread-1", ticket, decision: "approve" }
    });
    expect(stolen.structuredContent).toMatchObject({ code: "approval_ticket_invalid" });
    expect(backend.decideForPerson).not.toHaveBeenCalled();

    // The ticket was spent by the attempt above, so show the card again.
    const again = await client.callTool({ name: "show_review", arguments: { request_id: "thread-1" } });
    const fresh = (again._meta as Record<string, { ticket: string }>)["sitepilot/approval"]?.ticket ?? "";
    const clicked = await client.callTool({
      name: "decide_from_card",
      arguments: { request_id: "thread-1", ticket: fresh, decision: "approve" }
    });
    expect(text(clicked)).toContain("Approved");
    expect(backend.decideForPerson).toHaveBeenCalledWith(
      expect.objectContaining({ candidateId: "candidate-7", channel: "review_card" }),
      expect.anything()
    );
    const reused = await client.callTool({
      name: "decide_from_card",
      arguments: { request_id: "thread-1", ticket: fresh, decision: "approve" }
    });
    expect(reused.structuredContent).toMatchObject({ code: "approval_ticket_invalid" });
  });

  it("shows the card without buttons to someone who can't publish", async () => {
    const client = await connect(approvalBackend(), {
      actor: { userProfileId: "wp-site-1-9", appRole: "requester", siteRoles: ["request"] }
    });
    const shown = await client.callTool({ name: "show_review", arguments: { request_id: "thread-1" } });
    expect(shown._meta?.["sitepilot/approval"]).toBeUndefined();
  });

  it("serves the review card as an MCP App", async () => {
    const client = await connect(approvalBackend(), { actor: PUBLISHER });
    const read = await client.readResource({ uri: "ui://sitepilot/review-card.html" });
    const card = read.contents[0] as { mimeType?: string; text?: string; _meta?: { ui?: { csp?: { resourceDomains?: string[] } } } };
    expect(card.mimeType).toBe("text/html;profile=mcp-app");
    expect(card._meta?.ui?.csp?.resourceDomains).toEqual(["https://sitepilot.example"]);
    expect(card.text).toContain("decide_from_card");
    expect(card.text).toContain("const SitePilotApps = {");
  });
});

describe("signed preview links", () => {
  const links = createReviewLinks({ secretsKey: Buffer.alloc(32, 7), publicUrl: new URL("https://sitepilot.example") });

  it("open the preview they were made for, for 24 hours, and can't be altered", () => {
    const url = links.url({ siteId: "site-1", requestId: "thread-1", artifactId: "preview-0" }, 1_000);
    const token = new URL(url).pathname.slice("/r/".length);
    expect(links.verify(token, 1_000 + 60)).toEqual({ siteId: "site-1", requestId: "thread-1", artifactId: "preview-0" });
    expect(links.verify(token, 1_000 + 24 * 60 * 60 + 1)).toBeNull();
    const [payload, signature] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ s: "site-1", r: "thread-2", a: "preview-0", e: 99_999_999 })).toString("base64url");
    expect(links.verify(`${forged}.${signature}`, 1_000)).toBeNull();
    expect(links.verify(`${payload}.${signature}x`, 1_000)).toBeNull();
    const otherKey = createReviewLinks({ secretsKey: Buffer.alloc(32, 8), publicUrl: new URL("https://sitepilot.example") });
    expect(otherKey.verify(token, 1_000)).toBeNull();
  });
});
