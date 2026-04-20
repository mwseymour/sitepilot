export type ChatRole = "system" | "user" | "assistant";

export type ChatMessage = {
  role: ChatRole;
  content: string;
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
