import type {
  ChatCompletionResult,
  ChatMessage,
  ChatModelClient
} from "./types.js";

type AnthropicMessageResponse = {
  content?: Array<{ type?: string; text?: string }>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
  error?: { message?: string };
};

function splitSystemUser(messages: ChatMessage[]): {
  system: string;
  user: string;
} {
  const systemParts: string[] = [];
  const userParts: string[] = [];
  for (const m of messages) {
    if (m.role === "system") {
      systemParts.push(m.content);
    } else if (m.role === "user") {
      userParts.push(m.content);
    } else {
      userParts.push(m.content);
    }
  }
  return {
    system: systemParts.join("\n\n"),
    user: userParts.join("\n\n")
  };
}

export function createAnthropicChatClient(
  apiKey: string,
  options: { baseUrl?: string } = {}
): ChatModelClient {
  const baseUrl = (options.baseUrl ?? "https://api.anthropic.com").replace(
    /\/$/,
    ""
  );

  return {
    providerId: "anthropic",
    async complete(
      messages: ChatMessage[],
      model: string
    ): Promise<ChatCompletionResult> {
      const { system, user } = splitSystemUser(messages);

      const res = await fetch(`${baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01"
        },
        body: JSON.stringify({
          model,
          max_tokens: 4096,
          system: system.length > 0 ? system : undefined,
          messages: [{ role: "user", content: user }]
        })
      });

      const body = (await res.json()) as AnthropicMessageResponse;
      if (!res.ok) {
        throw new Error(
          body.error?.message ?? `Anthropic request failed (${res.status})`
        );
      }

      const text =
        body.content
          ?.map((c) => (c.type === "text" ? (c.text ?? "") : ""))
          .join("") ?? "";

      const usage = {
        inputTokens: body.usage?.input_tokens ?? 0,
        outputTokens: body.usage?.output_tokens ?? 0
      };

      return { text, usage };
    }
  };
}
