import type {
  ChatCompletionResult,
  ChatMessage,
  ChatModelClient
} from "./types.js";

type AnthropicTextBlock = { type: "text"; text: string };
type AnthropicImageBlock = {
  type: "image";
  source: {
    type: "base64";
    media_type: string;
    data: string;
  };
};
type AnthropicContentBlock = AnthropicTextBlock | AnthropicImageBlock;

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
  user: AnthropicContentBlock[];
} {
  const systemParts: string[] = [];
  const userParts: AnthropicContentBlock[] = [];

  const appendUserContent = (content: ChatMessage["content"]) => {
    if (typeof content === "string") {
      userParts.push({ type: "text", text: content });
      return;
    }

    for (const part of content) {
      if (part.type === "text") {
        userParts.push({ type: "text", text: part.text });
        continue;
      }
      const match = part.dataUrl.match(/^data:([^;]+);base64,(.+)$/);
      if (!match) {
        continue;
      }
      userParts.push({
        type: "image",
        source: {
          type: "base64",
          media_type: part.mediaType || match[1] || "image/png",
          data: match[2] || ""
        }
      });
    }
  };

  for (const m of messages) {
    if (m.role === "system") {
      systemParts.push(
        typeof m.content === "string"
          ? m.content
          : m.content
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join("\n\n")
      );
    } else {
      appendUserContent(m.content);
    }
  }
  return {
    system: systemParts.join("\n\n"),
    user: userParts
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
