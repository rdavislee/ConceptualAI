import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { syncTestables } from "./sync.ts";

Deno.test("sync sanitizer redacts GitHub callback and token-bearing log values", () => {
  const sanitized = syncTestables.sanitizeForLog({
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
