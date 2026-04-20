import type {
  ChatCompletionResult,
  ChatMessage,
  ChatModelClient
} from "./types.js";

type OpenAiChatResponse = {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
  error?: { message?: string };
};

export function createOpenAiChatClient(
  apiKey: string,
  options: { baseUrl?: string } = {}
): ChatModelClient {
  const baseUrl = (options.baseUrl ?? "https://api.openai.com/v1").replace(
    /\/$/,
    ""
  );

  return {
    providerId: "openai",
    async complete(
      messages: ChatMessage[],
      model: string
    ): Promise<ChatCompletionResult> {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model,
          messages,
          response_format: { type: "json_object" }
        })
      });

      const body = (await res.json()) as OpenAiChatResponse;
      if (!res.ok) {
        throw new Error(
          body.error?.message ?? `OpenAI request failed (${res.status})`
        );
      }

      const text = body.choices?.[0]?.message?.content ?? "";
      const usage = {
        inputTokens: body.usage?.prompt_tokens ?? 0,
        outputTokens: body.usage?.completion_tokens ?? 0
      };

      return { text, usage };
    }
  };
}
