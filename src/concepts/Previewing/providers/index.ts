import { MockPreviewProvider } from "./mock_provider.ts";
import { DenoPreviewProvider } from "./deno_provider.ts";
import { FreestylePreviewProvider } from "./freestyle_provider.ts";
import { PreviewProvider } from "./types.ts";

export function createPreviewProviderFromEnv(): PreviewProvider {
  const name = (Deno.env.get("PREVIEW_PROVIDER") || "freestyle").trim()
    .toLowerCase();
  switch (name) {
    case "mock":
      return new MockPreviewProvider();
    case "freestyle":
      return new FreestylePreviewProvider();
    case "deno":
    default:
      return new DenoPreviewProvider();
  }
}

export type { PreviewProvider } from "./types.ts";
