import { PreviewLaunchInput, PreviewLaunchOutput, PreviewProvider, PreviewTeardownInput } from "./types.ts";

const DEFAULT_MOCK_BASE_URL = "https://preview.localhost";

export class MockPreviewProvider implements PreviewProvider {
  constructor(private readonly baseUrl: string = DEFAULT_MOCK_BASE_URL) {}

  async launch(input: PreviewLaunchInput): Promise<PreviewLaunchOutput> {
    const backendAppId = `mock-backend-${input.launchId}`;
    const frontendAppId = `mock-frontend-${input.launchId}`;

    return {
      backendAppId,
      backendUrl: `${this.baseUrl}/${backendAppId}`,
      frontendAppId,
      frontendUrl: `${this.baseUrl}/${frontendAppId}`,
    };
  }

  async teardown(_input: PreviewTeardownInput): Promise<void> {
    // Intentionally a no-op for tests/local development.
  }
}
