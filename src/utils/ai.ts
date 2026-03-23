import { load } from "jsr:@std/dotenv";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createXai } from "@ai-sdk/xai";
import {
  generateObject as sdkGenerateObject,
  generateText as sdkGenerateText,
  jsonSchema,
} from "ai";

await load({ export: true });

export type AIProvider = "openai" | "anthropic" | "gemini" | "xai";
export type JSONSchema = Record<string, unknown>;

const DEFAULT_MODELS: Record<AIProvider, string> = {
  openai: "gpt-4o",
  anthropic: "claude-3-5-sonnet-20241022",
  gemini: "gemini-flash-latest",
  xai: "grok-beta",
};

export async function generateText(
  userPrompt: string,
  systemPrompt: string,
): Promise<string> {
  const model = resolveLanguageModel();
  const { text } = await sdkGenerateText({
    model,
    prompt: userPrompt,
    system: systemPrompt,
  });

  return text;
}

export async function generateObject<T>(
  userPrompt: string,
  systemPrompt: string,
  schema: JSONSchema,
): Promise<T> {
  const model = resolveLanguageModel();
  const { object } = await sdkGenerateObject({
    model,
    prompt: userPrompt,
    system: systemPrompt,
    schema: jsonSchema(schema),
  });

  return object as T;
}

function resolveLanguageModel() {
  const provider = resolveProvider();
  const modelId = resolveModelId(provider);
  const apiKey = resolveApiKey(provider);

  switch (provider) {
    case "openai":
      return createOpenAI({ apiKey })(modelId);
    case "anthropic":
      return createAnthropic({ apiKey })(modelId);
    case "gemini":
      return createGoogleGenerativeAI({ apiKey })(modelId);
    case "xai":
      return createXai({ apiKey })(modelId);
  }
}

function resolveProvider(): AIProvider {
  const provider = (Deno.env.get("AI_PROVIDER") ?? "gemini").toLowerCase();

  if (
    provider !== "openai" &&
    provider !== "anthropic" &&
    provider !== "gemini" &&
    provider !== "xai"
  ) {
    throw new Error(`Unsupported AI_PROVIDER: ${provider}`);
  }

  return provider;
}

function resolveModelId(provider: AIProvider): string {
  const sharedModel = Deno.env.get("AI_MODEL");

  if (sharedModel) {
    return sharedModel;
  }

  switch (provider) {
    case "openai":
      return Deno.env.get("OPENAI_MODEL") ?? DEFAULT_MODELS.openai;
    case "anthropic":
      return Deno.env.get("ANTHROPIC_MODEL") ?? DEFAULT_MODELS.anthropic;
    case "gemini":
      return Deno.env.get("GEMINI_MODEL_FLASH") ??
        Deno.env.get("GEMINI_MODEL") ??
        DEFAULT_MODELS.gemini;
    case "xai":
      return Deno.env.get("XAI_MODEL") ?? DEFAULT_MODELS.xai;
  }
}

function resolveApiKey(provider: AIProvider): string {
  let apiKey: string | undefined;

  switch (provider) {
    case "openai":
      apiKey = Deno.env.get("OPENAI_API_KEY");
      break;
    case "anthropic":
      apiKey = Deno.env.get("ANTHROPIC_API_KEY");
      break;
    case "gemini":
      apiKey = Deno.env.get("GEMINI_API_KEY") ??
        Deno.env.get("GOOGLE_GENERATIVE_AI_API_KEY");
      break;
    case "xai":
      apiKey = Deno.env.get("XAI_API_KEY");
      break;
  }

  if (!apiKey) {
    throw new Error(`Missing API key for provider: ${provider}`);
  }

  return apiKey;
}
