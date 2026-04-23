export type ChatRole = "system" | "user" | "assistant";

export type ChatContentPart =
  | {
      type: "text";
      text: string;
    }
  | {
      type: "image";
      mediaType: string;
      dataUrl: string;
    };

export type ChatMessage = {
  role: ChatRole;
  content: string | ChatContentPart[];
};

export type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
};

export type ChatCompletionResult = {
  text: string;
  usage: TokenUsage;
};

export type ChatModelClient = {
  readonly providerId: "openai" | "anthropic";
  complete(
    messages: ChatMessage[],
    model: string
  ): Promise<ChatCompletionResult>;
};
