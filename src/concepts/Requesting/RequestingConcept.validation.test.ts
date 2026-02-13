import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { requestingTestables } from "./RequestingConcept.ts";

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

Deno.test("RequestingConcept Gemini credential validation", async (t) => {
  await t.step("returns 400 when key header is missing", async () => {
    requestingTestables.clearGeminiCredentialCache();
    const result = await requestingTestables.validateGeminiCredentials(
      "",
      "1",
    );
    assertEquals(result, {
      ok: false,
      statusCode: 400,
      error: "Missing required header: X-Gemini-Api-Key.",
    });
  });

  await t.step("returns 400 when tier header is missing", async () => {
    requestingTestables.clearGeminiCredentialCache();
    const result = await requestingTestables.validateGeminiCredentials(
      "AIza12345678901234567890",
      "",
    );
    assertEquals(result, {
      ok: false,
      statusCode: 400,
      error: "Missing required header: X-Gemini-Tier.",
    });
  });

  await t.step("returns 400 when tier is 0 (free tier blocked)", async () => {
    requestingTestables.clearGeminiCredentialCache();
    const result = await requestingTestables.validateGeminiCredentials(
      "AIza12345678901234567890",
      "0",
    );
    assertEquals(result, {
      ok: false,
      statusCode: 400,
      error: "Invalid Gemini tier. Allowed values are 1, 2, or 3.",
    });
  });

  await t.step("returns 400 for invalid Gemini key", async () => {
    requestingTestables.clearGeminiCredentialCache();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      jsonResponse(401, { error: { message: "API key not valid." } })) as
      typeof fetch;

    try {
      const result = await requestingTestables.validateGeminiCredentials(
        "AIzaInvalidKey123456789012345",
        "1",
      );
      assertEquals(result, {
        ok: false,
        statusCode: 400,
        error: "Invalid Gemini API key.",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  await t.step(
    "returns 400 when key cannot access required non-free probe model",
    async () => {
      requestingTestables.clearGeminiCredentialCache();
      const originalFetch = globalThis.fetch;
      let fetchCalls = 0;
      globalThis.fetch = (async (input: string | URL | Request) => {
        fetchCalls += 1;
        const url = typeof input === "string"
          ? input
          : input instanceof URL
          ? input.toString()
          : input.url;
        if (url.includes("/models?")) {
          return jsonResponse(200, {
            models: [{
              name: "models/gemini-2.0-flash",
              supportedGenerationMethods: ["generateContent"],
            }],
          });
        }
        return jsonResponse(500, { error: { message: "Unexpected call" } });
      }) as typeof fetch;

      try {
        const result = await requestingTestables.validateGeminiCredentials(
          "AIzaFreeTierLikeKey1234567890",
          "1",
        );
        assertEquals(result, {
          ok: false,
          statusCode: 400,
          error:
            "Gemini API key does not meet required paid tier access (tier 0/free is unsupported).",
        });
        assertEquals(fetchCalls, 1);
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  );

  await t.step("returns 200-path result for valid paid key + tier", async () => {
    requestingTestables.clearGeminiCredentialCache();
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = (async (input: string | URL | Request) => {
      fetchCalls += 1;
      const url = typeof input === "string"
        ? input
        : input instanceof URL
        ? input.toString()
        : input.url;
      if (url.includes("/models?")) {
        return jsonResponse(200, {
          models: [{
            name: requestingTestables.probeModel,
            supportedGenerationMethods: ["generateContent"],
          }],
        });
      }
      if (url.includes(":generateContent?")) {
        return jsonResponse(200, { candidates: [{ content: {} }] });
      }
      return jsonResponse(500, { error: { message: "Unexpected URL" } });
    }) as typeof fetch;

    try {
      const result = await requestingTestables.validateGeminiCredentials(
        "AIzaPaidTierLikeKey1234567890",
        "2",
      );
      assertEquals(result, { ok: true });
      assertEquals(fetchCalls, 2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  await t.step("returns 503 during provider/network ambiguity", async () => {
    requestingTestables.clearGeminiCredentialCache();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error("network unavailable");
    }) as typeof fetch;

    try {
      const result = await requestingTestables.validateGeminiCredentials(
        "AIzaTransientFailure1234567890",
        "1",
      );
      assertEquals(result, {
        ok: false,
        statusCode: 503,
        error:
          "Unable to verify Gemini credentials right now. Please retry shortly.",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
