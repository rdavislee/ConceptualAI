import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { requestingTestables } from "./RequestingConcept.ts";

Deno.test("RequestingConcept sanitizes Gemini vault secrets", async (t) => {
  await t.step("redacts request fields by key name", () => {
    const sanitized = requestingTestables.sanitizeForPersistence({
      geminiKey: "AIza12345678901234567890",
      geminiUnwrapKey: "base64-unwrap-key",
      ciphertext: "ciphertext-value",
      iv: "iv-value",
      accountPassword: "password123",
      nested: {
        Authorization: "Bearer abc.def.ghi",
        refreshToken: "refresh-token",
      },
    });

    assertEquals(sanitized, {
      geminiKey: "[REDACTED]",
      geminiUnwrapKey: "[REDACTED]",
      ciphertext: "[REDACTED]",
      iv: "[REDACTED]",
      accountPassword: "[REDACTED]",
      nested: {
        Authorization: "[REDACTED]",
        refreshToken: "[REDACTED]",
      },
    });
  });

  await t.step("redacts string values that look like API keys or bearer tokens", () => {
    const sanitized = requestingTestables.sanitizeForPersistence({
      someString: "AIza12345678901234567890",
      bearer: "Bearer abc.def.ghi",
      safe: "hello",
    });

    assertEquals(sanitized, {
      someString: "[REDACTED]",
      bearer: "[REDACTED]",
      safe: "hello",
    });
  });
});
