import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import RequestingConcept, { requestingTestables } from "./RequestingConcept.ts";
import { testDb } from "@utils/database.ts";

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

  await t.step("redacts GitHub callback params and credential-bearing URLs", () => {
    const sanitized = requestingTestables.sanitizeForPersistence({
      path: "/auth/github/callback",
      code: "github-oauth-code-123",
      state: "signed.github.state",
      authorizationUrl:
        "https://github.com/login/oauth/authorize?client_id=test&state=signed.github.state",
      gitRemote:
        "https://x-access-token:ghu_secret_token_value@github.com/octocat/repo.git",
      rawGithubToken: "ghu_secret_token_value",
      safe: "hello",
    });

    assertEquals(sanitized, {
      path: "/auth/github/callback",
      code: "[REDACTED]",
      state: "[REDACTED]",
      authorizationUrl: "[REDACTED]",
      gitRemote: "[REDACTED]",
      rawGithubToken: "[REDACTED]",
      safe: "hello",
    });
  });

  await t.step("sanitizes persisted responses before saving request records", async () => {
    const [db, client] = await testDb();
    try {
      const Requesting = new RequestingConcept(db);
      const { request } = await Requesting.request({
        path: "/me/github/link/start",
      });

      await Requesting.respond({
        request,
        authorizationUrl:
          "https://github.com/login/oauth/authorize?client_id=test&state=signed.github.state",
        accessToken: "ghu_secret_token_value",
      });

      const saved = await db.collection("Requesting.requests").findOne({ _id: request });
      assertEquals(saved?.response, {
        authorizationUrl: "[REDACTED]",
        accessToken: "[REDACTED]",
      });
    } finally {
      await client.close();
    }
  });
});
