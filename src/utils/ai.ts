import { load } from "jsr:@std/dotenv";

// Load environment variables
await load({ export: true });

export type AIProvider = "openai" | "anthropic" | "gemini" | "xai";

export interface AIRequest {
  provider?: AIProvider;
  model?: string;
  system?: string;
  user: string;
  schema?: object; // JSON Schema for structured output
  apiKey?: string;
  maxTokens?: number;
  temperature?: number;
}

export interface AIResponse<T = unknown> {
  data: T;
  raw: unknown;
  usage?: {
    input_tokens: number;
    output_tokens: number;
  };
}

/**
 * Universal AI caller that enforces JSON output based on a schema.
 */
export async function generateJSON<T = unknown>(request: AIRequest): Promise<AIResponse<T>> {
  const provider = request.provider || Deno.env.get("AI_PROVIDER") as AIProvider || "gemini";
  const model = request.model || Deno.env.get("AI_MODEL") || getDefaultModel(provider);
  const apiKey = request.apiKey || getApiKey(provider);

  if (!apiKey) {
    throw new Error(`Missing API key for provider: ${provider}`);
  }

  let lastError: Error | undefined;
  const maxRetries = 3;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      switch (provider) {
        case "openai":
        case "xai":
          return await callOpenAICompatible<T>(provider, model, apiKey, request);
        case "anthropic":
          return await callAnthropic<T>(model, apiKey, request);
        case "gemini":
          return await callGemini<T>(model, apiKey, request);
        default:
          throw new Error(`Unsupported provider: ${provider}`);
      }
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
      if (attempt < maxRetries) {
        console.warn(`[AI] Attempt ${attempt + 1} failed: ${lastError.message}. Retrying...`);
      }
    }
  }

  throw lastError || new Error("AI generation failed with unknown error");
}

function getDefaultModel(provider: AIProvider): string {
  switch (provider) {
    case "openai": return "gpt-4o";
    case "anthropic": return "claude-3-5-sonnet-20241022";
    case "gemini": return "gemini-1.5-pro";
    case "xai": return "grok-beta";
    default: return "";
  }
}

function getApiKey(provider: AIProvider): string | undefined {
  switch (provider) {
    case "openai": return Deno.env.get("OPENAI_API_KEY");
    case "anthropic": return Deno.env.get("ANTHROPIC_API_KEY");
    case "gemini": return Deno.env.get("GEMINI_API_KEY");
    case "xai": return Deno.env.get("XAI_API_KEY");
    default: return undefined;
  }
}

// --- Providers ---

async function callOpenAICompatible<T>(
  provider: "openai" | "xai",
  model: string,
  apiKey: string,
  request: AIRequest
): Promise<AIResponse<T>> {
  const baseUrl = provider === "xai" 
    ? "https://api.x.ai/v1/chat/completions" 
    : "https://api.openai.com/v1/chat/completions";

  const headers = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${apiKey}`
  };

  const messages = [];
  if (request.system) messages.push({ role: "system", content: request.system });
  messages.push({ role: "user", content: request.user });

  const body: any = {
    model,
    messages,
    temperature: request.temperature ?? 0.1,
    max_tokens: request.maxTokens,
  };

  if (request.schema) {
    if (provider === "openai") {
      // OpenAI Structured Outputs
      body.response_format = {
        type: "json_schema",
        json_schema: {
          name: "output_schema",
          strict: true,
          schema: request.schema
        }
      };
    } else {
      // xAI / Generic JSON Mode fallback
      body.response_format = { type: "json_object" };
      // Append schema instruction if not supported natively
      if (!request.system?.includes("JSON")) {
         messages.unshift({ role: "system", content: `You must output valid JSON matching this schema: ${JSON.stringify(request.schema)}` });
      }
    }
  }

  const resp = await fetch(baseUrl, {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`${provider} API error (${resp.status}): ${err}`);
  }

  const json = await resp.json();
  const content = json.choices[0].message.content;
  
  try {
    const data = JSON.parse(content);
    return {
      data,
      raw: json,
      usage: {
        input_tokens: json.usage?.prompt_tokens || 0,
        output_tokens: json.usage?.completion_tokens || 0
      }
    };
  } catch (e) {
    throw new Error(`Failed to parse JSON response from ${provider}: ${content}`);
  }
}

async function callAnthropic<T>(
  model: string,
  apiKey: string,
  request: AIRequest
): Promise<AIResponse<T>> {
  const headers = {
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01",
    "content-type": "application/json"
  };

  const body: any = {
    model,
    max_tokens: request.maxTokens ?? 4096,
    temperature: request.temperature ?? 0.1,
    messages: [{ role: "user", content: request.user }],
  };

  if (request.system) {
    body.system = request.system;
  }

  if (request.schema) {
    // Anthropic Tool Use for forced structure
    body.tools = [{
      name: "output_formatter",
      description: "Format the output according to the schema",
      input_schema: request.schema
    }];
    body.tool_choice = { type: "tool", name: "output_formatter" };
  }

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers,
    body: JSON.stringify(body)
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Anthropic API error (${resp.status}): ${err}`);
  }

  const json = await resp.json();

  if (request.schema) {
    // Look for tool use
    const toolUse = json.content.find((c: any) => c.type === "tool_use");
    if (toolUse) {
      return {
        data: toolUse.input as T,
        raw: json,
        usage: {
          input_tokens: json.usage?.input_tokens || 0,
          output_tokens: json.usage?.output_tokens || 0
        }
      };
    }
    // Fallback if model didn't use tool (unlikely with tool_choice)
    throw new Error(`Anthropic model did not use the output tool. Content: ${JSON.stringify(json.content)}`);
  } else {
    // Plain text
    const text = json.content.find((c: any) => c.type === "text")?.text || "";
    return {
      data: text as unknown as T, // Caller expects string if T is string
      raw: json,
      usage: {
        input_tokens: json.usage?.input_tokens || 0,
        output_tokens: json.usage?.output_tokens || 0
      }
    };
  }
}

async function callGemini<T>(
  model: string,
  apiKey: string,
  request: AIRequest
): Promise<AIResponse<T>> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const body: any = {
    contents: [
      {
        parts: [{ text: (request.system ? `System: ${request.system}\n\n` : "") + `User: ${request.user}` }]
      }
    ],
    generationConfig: {
      temperature: request.temperature ?? 0.1,
      maxOutputTokens: request.maxTokens
    }
  };

  if (request.schema) {
    body.generationConfig.responseMimeType = "application/json";
    body.generationConfig.responseSchema = request.schema;
  }

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Gemini API error (${resp.status}): ${err}`);
  }

  const json = await resp.json();
  const text = json.candidates?.[0]?.content?.parts?.[0]?.text;

  if (!text) {
     throw new Error(`Gemini returned no content: ${JSON.stringify(json)}`);
  }

  try {
    const data = JSON.parse(text);
    return {
      data,
      raw: json,
      usage: {
        input_tokens: json.usageMetadata?.promptTokenCount || 0,
        output_tokens: json.usageMetadata?.candidatesTokenCount || 0
      }
    };
  } catch (e) {
    throw new Error(`Failed to parse JSON response from Gemini: ${text}`);
  }
}
