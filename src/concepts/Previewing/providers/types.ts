import { ID } from "@utils/types.ts";

export interface PreviewLaunchInput {
  project: ID;
  launchId: string;
  backendZip: Uint8Array;
  frontendZip: Uint8Array;
  backendEnv: Record<string, string>;
}

export interface PreviewLaunchOutput {
  backendAppId: string;
  backendUrl: string;
  frontendAppId: string;
  frontendUrl: string;
}

export interface PreviewTeardownInput {
  backendAppId?: string;
  frontendAppId?: string;
}

export interface PreviewProvider {
  launch(input: PreviewLaunchInput): Promise<PreviewLaunchOutput>;
  teardown(input: PreviewTeardownInput): Promise<void>;
}
