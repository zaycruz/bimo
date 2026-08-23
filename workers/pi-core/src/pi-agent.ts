type ToolBridge = {
  call(name: string, args: unknown, id: string): Promise<unknown>;
};

type PiAgent = {
  state: {
    tools: unknown[];
    messages: unknown[];
    errorMessage?: string;
  };
  prompt(input: string): Promise<void>;
  abort(): void;
  waitForIdle(): Promise<void>;
};

export interface AgentSeam {
  run(prompt: string, tools: ToolBridge, signal: AbortSignal): Promise<string>;
  waitForIdle(): Promise<void>;
}

export type AgentFactory = (config: Record<string, unknown>) => AgentSeam | Promise<AgentSeam>;

function textFromAssistantMessages(messages: unknown[]): string {
  for (const message of [...messages].reverse()) {
    if (
      typeof message !== "object" ||
      message === null ||
      !("role" in message) ||
      message.role !== "assistant" ||
      !("content" in message) ||
      !Array.isArray(message.content)
    ) {
      continue;
    }
    const text = message.content
      .flatMap((part) => {
        if (
          typeof part !== "object" ||
          part === null ||
          !("type" in part) ||
          part.type !== "text" ||
          !("text" in part) ||
          typeof part.text !== "string"
        ) {
          return [];
        }
        return [part.text];
      })
      .join("");
    if (text) return text;
  }
  return "";
}

export async function createPiAgent(config: Record<string, unknown>): Promise<AgentSeam> {
  const provider = config.provider;
  const modelName = config.model;
  if (typeof provider !== "string" || typeof modelName !== "string") {
    throw new Error("Pi worker config requires provider and model");
  }

  const [{ Agent }, { Type, getModel }] = await Promise.all([
    import("@mariozechner/pi-agent-core"),
    import("@mariozechner/pi-ai"),
  ]);
  const model = getModel(provider as never, modelName as never);
  const agent = new Agent({
    initialState: {
      model,
      systemPrompt: typeof config.system_prompt === "string" ? config.system_prompt : "",
    },
    toolExecution: "sequential",
  }) as unknown as PiAgent;

  return {
    async run(prompt, tools, signal) {
      const toolNames =
        Array.isArray(config.tools) && config.tools.every((value) => typeof value === "string")
          ? config.tools
          : ["pod.send_message", "factory.read_state"];
      agent.state.tools = toolNames.map((name) => ({
        name,
        label: name,
        description: `Rust-gated ${name} capability`,
        parameters: Type.Any(),
        executionMode: "sequential",
        execute: async (toolCallId: string, args: unknown) => {
          const result = await tools.call(name, args, toolCallId);
          return {
            content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result) }],
            details: result,
          };
        },
      }));

      const abort = () => agent.abort();
      signal.addEventListener("abort", abort, { once: true });
      try {
        if (signal.aborted) throw new Error("cancelled");
        await agent.prompt(prompt);
        await agent.waitForIdle();
        if (signal.aborted) throw new Error("cancelled");
        if (agent.state.errorMessage) throw new Error(agent.state.errorMessage);
        return textFromAssistantMessages(agent.state.messages) || "Pi agent completed without text output";
      } finally {
        signal.removeEventListener("abort", abort);
      }
    },
    waitForIdle: () => agent.waitForIdle(),
  };
}
