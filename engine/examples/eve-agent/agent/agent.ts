import { openrouter } from "@openrouter/ai-sdk-provider";
import { defineAgent } from "eve";

// OPENROUTER_API_KEY is read when a request is made. Under Monolith the agent
// holds only a placeholder; the per-agent proxy substitutes the real key on
// the way to openrouter.ai.
export default defineAgent({
  model: openrouter("openai/gpt-4o-mini"),
  // Direct provider models carry no gateway metadata; eve needs the window.
  modelContextWindowTokens: 128_000,
});
