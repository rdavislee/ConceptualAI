import JSZip from "https://esm.sh/jszip@3.10.1";
import * as path from "https://deno.land/std@0.224.0/path/mod.ts";
import {
  PreviewLaunchInput,
  PreviewLaunchOutput,
  PreviewProvider,
  PreviewTeardownInput,
} from "./types.ts";

const DEFAULT_SANDBOX_TIMEOUT = "30m";
const DEFAULT_ALLOW_NET =
  "registry.npmjs.org,jsr.io,deno.land,esm.sh,api.deno.com,dl.deno.land";
const DEFAULT_URL_RESOLUTION_TIMEOUT_MS = 600_000;
const DEFAULT_URL_RESOLUTION_SOFT_TIMEOUT_MS = 120_000;
const URL_RESOLUTION_POLL_MS = 1_500;

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

type SandboxModule = {
  Client: new (args: { token: string; org?: string }) => any;
  Sandbox: { create: (options?: Record<string, unknown>) => Promise<any> };
};

function clipText(value: string | null | undefined, max = 1600): string {
  const text = (value || "").trim();
  if (!text) return "";
  if (text.length <= max) return text;
  return `${text.slice(0, max)}...<truncated>`;
}

function stripAnsi(value: string | null | undefined): string {
  if (!value) return "";
  return value.replaceAll(/\x1b\[[0-9;]*m/g, "");
}

export class DenoPreviewProvider implements PreviewProvider {
  private readonly token = Deno.env.get("DENO_DEPLOY_TOKEN")?.trim() ?? "";
  private readonly org = Deno.env.get("DENO_DEPLOY_ORG")?.trim() ||
    Deno.env.get("DENO_DEPLOY_ORG_ID")?.trim() || "";
  private readonly debug = (() => {
    const raw = (Deno.env.get("PREVIEW_DEBUG") || "").trim().toLowerCase();
    return raw === "1" || raw === "true" || raw === "yes";
  })();
  private readonly allowNet = this.readAllowNet();
  private readonly sandboxTimeout = Deno.env.get("PREVIEW_SANDBOX_TIMEOUT")
    ?.trim() || DEFAULT_SANDBOX_TIMEOUT;
  private readonly urlResolutionTimeoutMs = parsePositiveInt(
    Deno.env.get("PREVIEW_URL_RESOLUTION_TIMEOUT_MS"),
    DEFAULT_URL_RESOLUTION_TIMEOUT_MS,
  );
  private readonly urlResolutionSoftTimeoutMs = parsePositiveInt(
    Deno.env.get("PREVIEW_URL_RESOLUTION_SOFT_TIMEOUT_MS"),
    DEFAULT_URL_RESOLUTION_SOFT_TIMEOUT_MS,
  );
  private sdkPromise: Promise<SandboxModule> | null = null;

  private debugLog(message: string, data?: Record<string, unknown>) {
    if (!this.debug) return;
    if (data) {
      console.log(`[Previewing:Deno] ${message}`, data);
      return;
    }
    console.log(`[Previewing:Deno] ${message}`);
  }

  async launch(input: PreviewLaunchInput): Promise<PreviewLaunchOutput> {
    if (!this.token) {
      throw new Error("DENO_DEPLOY_TOKEN is not configured.");
    }

    const sdk = await this.getSdk();
    const client = this.org.length > 0
      ? new sdk.Client({ token: this.token, org: this.org })
      : new sdk.Client({ token: this.token });
    const tmpDir = await Deno.makeTempDir({
      prefix: "pv_",
    });

    let sandbox: any = null;
    let backendAppId: string | undefined;
    let frontendAppId: string | undefined;

    try {
      this.debugLog("Launch started", {
        project: input.project,
        launchId: input.launchId,
      });

      const backendDir = path.join(tmpDir, "b");
      const frontendDir = path.join(tmpDir, "f");

      // DEBUG: Write zip files to disk for inspection
      await Deno.writeFile("debug_backend.zip", input.backendZip);
      await Deno.writeFile("debug_frontend.zip", input.frontendZip);
      this.debugLog("Wrote debug ziples to debug_backend.zip and debug_frontend.zip");

      await this.extractZip(input.backendZip, backendDir);
      await this.extractZip(input.frontendZip, frontendDir);
      const backendProjectDir = await this.findDirectoryContainingFile(
        backendDir,
        "deno.json",
      );
      const frontendProjectDir = await this.findDirectoryContainingFile(
        frontendDir,
        "package.json",
      );
      await this.writeFrontendPreviewServer(frontendProjectDir);
      const backendRelativeDir = this.toPosixRelativePath(
        path.relative(tmpDir, backendProjectDir),
      );
      const frontendRelativeDir = this.toPosixRelativePath(
        path.relative(tmpDir, frontendProjectDir),
      );

      const backendName = this.buildAppName(
        input.project,
        input.launchId,
        "backend",
      );
      const frontendName = this.buildAppName(
        input.project,
        input.launchId,
        "frontend",
      );

      const backendApp = await client.apps.create({
        slug: backendName,
        env_vars: this.toProviderEnvVars(input.backendEnv),
      });
      const frontendApp = await client.apps.create({ slug: frontendName });
      backendAppId = String(backendApp.id);
      frontendAppId = String(frontendApp.id);
      const backendFallbackUrl = this.extractFirstUrl(backendApp) ??
        this.defaultDenoDeployUrlForSlug(backendName);
      const frontendFallbackUrl = this.extractFirstUrl(frontendApp) ??
        this.defaultDenoDeployUrlForSlug(frontendName);
      this.debugLog("Created deploy apps", {
        backendAppId,
        backendSlug: backendName,
        backendFallbackUrl,
        frontendAppId,
        frontendSlug: frontendName,
        frontendFallbackUrl,
      });

      const sandboxOptions: Record<string, unknown> = {
        timeout: this.sandboxTimeout,
      };
      if (this.allowNet.length > 0) {
        sandboxOptions.allowNet = this.allowNet;
      }

      sandbox = await sdk.Sandbox.create(sandboxOptions);
      await sandbox.fs.upload(tmpDir, ".");
      const backendSandboxDir = await this.resolveSandboxProjectDir(sandbox, {
        preferredRelativeDir: backendRelativeDir,
        markerFile: "deno.json",
        label: "backend",
      });
      const frontendSandboxDir = await this.resolveSandboxProjectDir(sandbox, {
        preferredRelativeDir: frontendRelativeDir,
        markerFile: "package.json",
        label: "frontend",
      });
      this.debugLog("Resolved sandbox directories", {
        backendSandboxDir,
        frontendSandboxDir,
      });
      const backendSandboxDirQuoted = this.shellQuote(backendSandboxDir);
      const frontendSandboxDirQuoted = this.shellQuote(frontendSandboxDir);

      // Generated backend artifacts rely on import barrel generation.
      try {
        await this.runBashChecked(
          sandbox,
          `cd ${backendSandboxDirQuoted} && deno task build`,
          "Backend build",
        );
      } catch (buildError) {
        try {
          await this.runBashChecked(
            sandbox,
            `cd ${backendSandboxDirQuoted} && deno run --allow-read --allow-write --allow-env src/utils/generate_imports.ts`,
            "Backend generate_imports fallback",
          );
        } catch (fallbackError) {
          const primaryMessage = buildError instanceof Error
            ? buildError.message
            : String(buildError);
          const fallbackMessage = fallbackError instanceof Error
            ? fallbackError.message
            : String(fallbackError);
          throw new Error(
            `Backend preparation failed. deno task build error: ${primaryMessage}. Fallback generate_imports error: ${fallbackMessage}`,
          );
        }
      }

      // Prevent oversized deploy uploads from generated dependency caches.
      await this.runBashChecked(
        sandbox,
        `cd ${backendSandboxDirQuoted} && rm -rf node_modules .deno .npm .cache .git .github .vscode dist build out coverage`,
        "Backend deploy prune",
      );
      this.debugLog("Backend deploy directory pruned", {
        backendSandboxDir,
      });

      const backendDeployPath = this.toSandboxAbsolutePath(backendSandboxDir);
      await this.debugLogDirectorySnapshot(
        sandbox,
        "Backend deploy source",
        backendSandboxDir,
        "src/main.ts",
      );

      const backendDeployOptions: Record<string, unknown> = {
        path: backendDeployPath,
        build: {
          mode: "none",
          entrypoint: "src/main.ts",
        },
      };
      this.debugLog("Starting backend deploy", {
        backendAppId,
        path: backendDeployPath,
        entrypoint: "src/main.ts",
        options: this.compactJson(backendDeployOptions, 1200),
      });

      const backendDeployment = await sandbox.deno.deploy(
        backendAppId,
        backendDeployOptions,
      );
      const backendUrl = await this.resolvePublicUrl({
        deployResult: backendDeployment,
        client,
        appId: backendAppId,
        appFallbackUrl: backendFallbackUrl,
      });
      const backendApiUrl = `${backendUrl.replace(/\/+$/, "")}/api`;
      const backendApiUrlQuoted = this.shellQuote(backendApiUrl);

      await this.runBashChecked(
        sandbox,
        `cd ${frontendSandboxDirQuoted} && if [ -f package-lock.json ]; then npm ci; else npm install; fi && VITE_API_URL=${backendApiUrlQuoted} npm run build`,
        "Frontend build",
      );

      const frontendDeployDir = "_fd";
      const frontendDeployDirQuoted = this.shellQuote(frontendDeployDir);
      await this.runBashChecked(
        sandbox,
        `rm -rf ${frontendDeployDirQuoted} && mkdir -p ${frontendDeployDirQuoted}/dist && cp -R ${frontendSandboxDirQuoted}/dist/. ${frontendDeployDirQuoted}/dist/ && cp ${frontendSandboxDirQuoted}/preview_server.ts ${frontendDeployDirQuoted}/preview_server.ts`,
        "Frontend deploy bundle prep",
      );
      const frontendDeployPath = this.toSandboxAbsolutePath(frontendDeployDir);
      this.debugLog("Frontend deploy bundle prepared", {
        frontendSandboxDir,
        frontendDeployDir,
      });
      await this.debugLogDirectorySnapshot(
        sandbox,
        "Frontend deploy source",
        frontendDeployDir,
        "preview_server.ts",
      );

      const frontendDeployOptions: Record<string, unknown> = {
        path: frontendDeployPath,
        build: {
          mode: "none",
          entrypoint: "preview_server.ts",
        },
      };
      this.debugLog("Starting frontend deploy", {
        frontendAppId,
        path: frontendDeployPath,
        entrypoint: "preview_server.ts",
        options: this.compactJson(frontendDeployOptions, 1200),
      });

      const frontendDeployment = await sandbox.deno.deploy(
        frontendAppId,
        frontendDeployOptions,
      );
      const frontendUrl = await this.resolvePublicUrl({
        deployResult: frontendDeployment,
        client,
        appId: frontendAppId,
        appFallbackUrl: frontendFallbackUrl,
      });

      return {
        backendAppId,
        backendUrl,
        frontendAppId,
        frontendUrl,
      };
    } catch (error) {
      if (frontendAppId) {
        await this.safeDeleteApp(client, frontendAppId);
      }
      if (backendAppId) {
        await this.safeDeleteApp(client, backendAppId);
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Deno preview deployment failed (project=${input.project}, launchId=${input.launchId}, backendAppId=${
          backendAppId ?? "n/a"
        }, frontendAppId=${frontendAppId ?? "n/a"}): ${message}`,
      );
    } finally {
      await this.safeDisposeSandbox(sandbox);
      try {
        await Deno.remove(tmpDir, { recursive: true });
      } catch {
        // Ignore temp cleanup failures.
      }
    }
  }

  async teardown(input: PreviewTeardownInput): Promise<void> {
    if (!this.token) return;
    const sdk = await this.getSdk();
    const client = this.org.length > 0
      ? new sdk.Client({ token: this.token, org: this.org })
      : new sdk.Client({ token: this.token });

    if (input.frontendAppId) {
      await this.safeDeleteApp(client, input.frontendAppId);
    }
    if (input.backendAppId) {
      await this.safeDeleteApp(client, input.backendAppId);
    }
  }

  private async getSdk(): Promise<SandboxModule> {
    if (!this.sdkPromise) {
      this.sdkPromise = import("npm:@deno/sandbox") as Promise<SandboxModule>;
    }
    return await this.sdkPromise;
  }

  private readAllowNet(): string[] {
    const raw = Deno.env.get("PREVIEW_SANDBOX_ALLOW_NET") ||
      DEFAULT_ALLOW_NET;
    return raw
      .split(",")
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
  }

  private buildAppName(
    project: string,
    launchId: string,
    flavor: "backend" | "frontend",
  ): string {
    const sanitize = (value: string) =>
      value
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-+|-+$/g, "");

    const flavorPart = flavor === "backend" ? "b" : "f";
    const projectPart = sanitize(project).replace(/-/g, "").slice(-8) || "proj";
    const launchPart = sanitize(launchId).replace(/-/g, "").slice(-12) ||
      "launch";
    // Keep under Deno app slug max length (32 chars).
    const slug = `pv-${flavorPart}-${projectPart}-${launchPart}`.slice(0, 32);
    return slug.replace(/^-+|-+$/g, "") || `pv-${flavorPart}-fallback`;
  }

  private defaultDenoDeployUrlForSlug(slug: string): string {
    return `https://${slug}.deno.dev`;
  }

  private toProviderEnvVars(
    env: Record<string, string> | undefined,
  ): Array<{ key: string; value: string; secret: boolean; contexts: "all" }> {
    if (!env) return [];
    return Object.entries(env)
      .filter(([key, value]) =>
        key.trim().length > 0 && typeof value === "string"
      )
      .map(([key, value]) => ({
        key,
        value,
        secret: true,
        contexts: "all" as const,
      }));
  }

  private normalizeZipPath(zipPath: string): string | null {
    const normalized = zipPath.replace(/\\/g, "/");
    if (normalized.startsWith("/") || normalized.includes("../")) {
      return null;
    }
    return normalized;
  }

  private async extractZip(zipData: Uint8Array, destinationDir: string) {
    await Deno.mkdir(destinationDir, { recursive: true });
    const zip = await JSZip.loadAsync(zipData);
    const files = Object.values(zip.files);

    for (const entry of files) {
      const normalized = this.normalizeZipPath(entry.name);
      if (!normalized) continue;
      const outputPath = path.join(destinationDir, normalized);

      if (entry.dir) {
        await Deno.mkdir(outputPath, { recursive: true });
        continue;
      }

      await Deno.mkdir(path.dirname(outputPath), { recursive: true });
      const content = await entry.async("uint8array");
      await Deno.writeFile(outputPath, content);
    }
  }

  private toPosixRelativePath(relativePath: string): string {
    const normalized = relativePath.replaceAll(path.SEPARATOR, "/").trim();
    if (!normalized || normalized === ".") {
      throw new Error("Invalid relative project path extracted from artifact.");
    }
    return normalized;
  }

  private normalizeSandboxDirPath(value: string): string {
    const lines = value
      .replaceAll(path.SEPARATOR, "/")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    if (lines.length === 0) {
      throw new Error("Sandbox directory resolution returned an empty path.");
    }
    const raw = lines[0].replace(/^\.\//, "").replace(/\/+$/, "");
    if (!raw || raw === ".") {
      throw new Error(`Invalid sandbox directory path returned: ${lines[0]}`);
    }
    return raw;
  }

  private shellQuote(value: string): string {
    return `'${value.replaceAll("'", "'\\''")}'`;
  }

  private toSandboxAbsolutePath(dirPath: string): string {
    const normalized = dirPath
      .replaceAll(path.SEPARATOR, "/")
      .replace(/^\.\//, "")
      .replace(/\/+$/, "");
    if (normalized.startsWith("/")) return normalized;
    return `/home/app/${normalized}`;
  }

  private async debugLogDirectorySnapshot(
    sandbox: any,
    label: string,
    dirPath: string,
    entrypoint?: string,
  ): Promise<void> {
    if (!this.debug) return;
    const dirQuoted = this.shellQuote(dirPath);
    const entrypointCheck = entrypoint
      ? `if [ -f ${
        this.shellQuote(entrypoint)
      } ]; then echo "__entrypoint__=present"; else echo "__entrypoint__=missing"; fi`
      : 'echo "__entrypoint__=n/a"';
    const command = [
      `cd ${dirQuoted}`,
      'echo "__pwd__=$(pwd)"',
      'echo "__files__=$(find . -type f | wc -l | tr -d " ")"',
      'echo "__dirs__=$(find . -type d | wc -l | tr -d " ")"',
      'echo "__symlinks__=$(find . -type l | wc -l | tr -d " ")"',
      "echo \"__size_kb__=$(du -sk . | awk '{print $1}')\"",
      entrypointCheck,
      'echo "__sample_begin__"',
      "find . -maxdepth 3 -type f | sed 's|^./||' | sort | head -n 40",
      'echo "__sample_end__"',
    ].join(" && ");

    try {
      const output = await this.runBashCaptureChecked(
        sandbox,
        command,
        `${label} diagnostics`,
      );
      this.debugLog(`${label} diagnostics`, {
        dirPath,
        details: clipText(stripAnsi(output), 4000),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.debugLog(`${label} diagnostics unavailable`, {
        dirPath,
        error: clipText(message, 1200),
      });
    }
  }

  private async resolveSandboxProjectDir(
    sandbox: any,
    {
      preferredRelativeDir,
      markerFile,
      label,
    }: {
      preferredRelativeDir: string;
      markerFile: string;
      label: "backend" | "frontend";
    },
  ): Promise<string> {
    const preferred = this.normalizeSandboxDirPath(preferredRelativeDir);
    const candidates = new Set<string>([preferred]);
    const preferredBase = path.posix.basename(preferred);
    if (preferredBase && preferredBase !== preferred) {
      candidates.add(preferredBase);
    }

    for (const candidate of candidates) {
      if (await this.sandboxPathHasFile(sandbox, candidate, markerFile)) {
        return candidate;
      }
    }

    const markerQuoted = this.shellQuote(markerFile);
    try {
      const discovered = await this.runBashCaptureChecked(
        sandbox,
        `match=$(find . -maxdepth 8 -type f -name ${markerQuoted} -not -path '*/node_modules/*' | head -n 1) && [ -n "$match" ] && dirname "$match"`,
        `Locate ${label} project root`,
      );
      return this.normalizeSandboxDirPath(discovered);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Could not resolve ${label} project root in sandbox. ${message}`,
      );
    }
  }

  private async sandboxPathHasFile(
    sandbox: any,
    dirPath: string,
    fileName: string,
  ): Promise<boolean> {
    const dir = this.normalizeSandboxDirPath(dirPath);
    const targetQuoted = this.shellQuote(`${dir}/${fileName}`);
    const output = await this.runBashCaptureChecked(
      sandbox,
      `if [ -f ${targetQuoted} ]; then echo 1; else echo 0; fi`,
      `Probe sandbox file ${dirPath}/${fileName}`,
    );
    return output.trim() === "1";
  }

  private async findDirectoryContainingFile(
    baseDir: string,
    fileName: string,
    maxDepth = 4,
  ): Promise<string> {
    const queue: Array<{ dir: string; depth: number }> = [{
      dir: baseDir,
      depth: 0,
    }];

    while (queue.length > 0) {
      const current = queue.shift()!;
      const marker = path.join(current.dir, fileName);
      try {
        const markerStat = await Deno.stat(marker);
        if (markerStat.isFile) return current.dir;
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) {
          throw error;
        }
      }

      if (current.depth >= maxDepth) continue;
      for await (const entry of Deno.readDir(current.dir)) {
        if (!entry.isDirectory) continue;
        queue.push({
          dir: path.join(current.dir, entry.name),
          depth: current.depth + 1,
        });
      }
    }

    throw new Error(
      `Could not locate ${fileName} under extracted artifact directory ${baseDir}.`,
    );
  }

  private formatBashFailure(
    label: string,
    command: string,
    result: any,
  ): string {
    const stdout = clipText(stripAnsi(result?.stdoutText));
    const stderr = clipText(stripAnsi(result?.stderrText));
    return [
      `${label} failed (exit ${result?.status?.code ?? "unknown"}).`,
      `command: ${command}`,
      stdout ? `stdout: ${stdout}` : "",
      stderr ? `stderr: ${stderr}` : "",
    ].filter((line) => line.length > 0).join(" ");
  }

  private async runBashCommand(
    sandbox: any,
    command: string,
  ): Promise<any> {
    const child = await sandbox.spawn("bash", {
      args: ["-c", command],
      stdout: "piped",
      stderr: "piped",
    });
    return await child.output();
  }

  private async runBashChecked(
    sandbox: any,
    command: string,
    label: string,
  ): Promise<void> {
    const result = await this.runBashCommand(sandbox, command);
    if (result.status.success) return;

    throw new Error(this.formatBashFailure(label, command, result));
  }

  private async runBashCaptureChecked(
    sandbox: any,
    command: string,
    label: string,
  ): Promise<string> {
    const result = await this.runBashCommand(sandbox, command);
    if (!result.status.success) {
      throw new Error(this.formatBashFailure(label, command, result));
    }
    return result.stdoutText || "";
  }

  private async writeFrontendPreviewServer(frontendDir: string) {
    const serverPath = path.join(frontendDir, "preview_server.ts");
    const script = `import { extname, join, normalize } from "jsr:@std/path";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8"
};

function contentType(filePath: string): string {
  return MIME[extname(filePath)] || "application/octet-stream";
}

function sanitizePath(pathname: string): string {
  const normalized = normalize(pathname).replace(/^\\/+/, "");
  if (normalized.startsWith("..")) return "index.html";
  return normalized.length === 0 ? "index.html" : normalized;
}

Deno.serve(async (request) => {
  const { pathname } = new URL(request.url);
  const requestedPath = sanitizePath(pathname);
  const filePath = join("dist", requestedPath);

  try {
    const content = await Deno.readFile(filePath);
    return new Response(content, {
      headers: {
        "Content-Type": contentType(filePath),
        "Cache-Control": "public, max-age=60"
      }
    });
  } catch {
    try {
      const indexFile = await Deno.readFile("dist/index.html");
      return new Response(indexFile, {
        headers: { "Content-Type": "text/html; charset=utf-8" }
      });
    } catch {
      return new Response("Preview frontend build output missing.", {
        status: 500
      });
    }
  }
});
`;

    await Deno.writeTextFile(serverPath, script);
  }

  private normalizePublicUrl(candidate: any): string | null {
    const raw = typeof candidate === "string"
      ? candidate
      : typeof candidate?.url === "string"
      ? candidate.url
      : typeof candidate?.href === "string"
      ? candidate.href
      : typeof candidate?.domain === "string"
      ? candidate.domain
      : typeof candidate?.defaultDomain === "string"
      ? candidate.defaultDomain
      : typeof candidate?.default_domain === "string"
      ? candidate.default_domain
      : "";
    if (!raw) return null;
    if (raw.startsWith("http://") || raw.startsWith("https://")) return raw;
    return `https://${raw}`;
  }

  private extractFirstUrl(payload: any): string | null {
    if (!payload) return null;
    if (Array.isArray(payload?.domains)) {
      for (const domain of payload.domains) {
        const normalized = this.normalizePublicUrl(domain);
        if (normalized) return normalized;
      }
    }
    return this.normalizePublicUrl(payload);
  }

  private extractUrlFromRevision(revision: any): string | null {
    return this.extractUrlFromTimelines(revision?.timelines);
  }

  private extractUrlFromTimelines(timelinesPayload: any): string | null {
    const timelines = Array.isArray(timelinesPayload)
      ? timelinesPayload
      : Array.isArray(timelinesPayload?.items)
      ? timelinesPayload.items
      : [];
    for (const timeline of timelines) {
      const domains = Array.isArray(timeline?.domains) ? timeline.domains : [];
      for (const domain of domains) {
        const normalized = this.normalizePublicUrl(domain);
        if (normalized) return normalized;
      }
    }
    return null;
  }

  private async awaitWithTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    timeoutMessage: string,
  ): Promise<T> {
    let timeoutId: number | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<T>((_, reject) => {
          timeoutId = setTimeout(
            () => reject(new Error(timeoutMessage)),
            timeoutMs,
          );
        }),
      ]);
    } finally {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }
    }
  }

  private async tryGetAppUrl(
    client: any,
    appId: string,
  ): Promise<string | null> {
    if (!(client?.apps && typeof client.apps.get === "function")) return null;
    try {
      const app = await client.apps.get(appId);
      return this.extractFirstUrl(app);
    } catch {
      return null;
    }
  }

  private async tryGetTimelineUrl(
    client: any,
    appId: string,
  ): Promise<string | null> {
    if (!(client?.timelines && typeof client.timelines.list === "function")) {
      return null;
    }
    try {
      const page = await client.timelines.list(appId, { limit: 20 });
      return this.extractUrlFromTimelines(page);
    } catch {
      return null;
    }
  }

  private async collectDeployLogTail(
    {
      deployResult,
      client,
      revisionId,
      maxEntries = 300,
      idleTimeoutMs = 10_000,
      totalTimeoutMs = 90_000,
    }: {
      deployResult: any;
      client?: any;
      revisionId?: string;
      maxEntries?: number;
      idleTimeoutMs?: number;
      totalTimeoutMs?: number;
    },
  ): Promise<string> {
    let iterable: AsyncIterable<any> | null = null;
    if (
      revisionId &&
      client?.revisions &&
      typeof client.revisions.buildLogs === "function"
    ) {
      try {
        iterable = client.revisions.buildLogs(revisionId);
      } catch {
        iterable = null;
      }
    }
    if (
      !iterable &&
      deployResult?.logs &&
      typeof deployResult.logs === "function"
    ) {
      try {
        iterable = deployResult.logs();
      } catch {
        iterable = null;
      }
    }
    if (!iterable || typeof iterable[Symbol.asyncIterator] !== "function") {
      return "";
    }

    const lines: string[] = [];
    try {
      const iterator = iterable[Symbol.asyncIterator]();
      const deadline = Date.now() + totalTimeoutMs;
      while (lines.length < maxEntries) {
        if (Date.now() >= deadline) break;
        let next: IteratorResult<any>;
        try {
          next = await this.awaitWithTimeout(
            iterator.next(),
            idleTimeoutMs,
            "Timed out waiting for build log entry",
          );
        } catch {
          break;
        }
        if (next.done) break;

        const level = typeof next.value?.level === "string"
          ? next.value.level
          : "info";
        const step = typeof next.value?.step === "string"
          ? `/${next.value.step}`
          : "";
        const message = typeof next.value?.message === "string"
          ? stripAnsi(next.value.message).trim()
          : "";
        if (!message) continue;
        lines.push(`${level}${step}: ${message}`);
      }
      if (typeof iterator.return === "function") {
        try {
          await iterator.return();
        } catch {
          // Ignore iterator close errors.
        }
      }
    } catch {
      // Ignore build log retrieval failures.
    }

    if (lines.length === 0) return "";
    const errorLines = lines.filter((line) =>
      line.toLowerCase().startsWith("error")
    );
    const picked = errorLines.length > 0
      ? errorLines.slice(-12)
      : lines.slice(-12);
    return picked.join(" | ");
  }

  private isTerminalFailureStatus(status: string | undefined): boolean {
    if (!status) return false;
    const normalized = status.trim().toLowerCase();
    return normalized === "error" || normalized === "failed" ||
      normalized === "canceled" || normalized === "cancelled";
  }

  private compactJson(value: unknown, max = 800): string {
    try {
      const json = JSON.stringify(value);
      return clipText(json, max);
    } catch {
      return "";
    }
  }

  private summarizeRevision(revision: any): string {
    if (!revision || typeof revision !== "object") return "";
    const summary = {
      id: revision?.id,
      status: revision?.status,
      created_at: revision?.created_at,
      updated_at: revision?.updated_at,
      error: revision?.error,
      message: revision?.message,
      reason: revision?.reason ?? revision?.failure_reason ??
        revision?.failureReason,
      diagnostics: revision?.diagnostics,
    };
    return this.compactJson(summary);
  }

  private async resolvePublicUrl(
    {
      deployResult,
      client,
      appId,
      appFallbackUrl,
    }: {
      deployResult: any;
      client: any;
      appId: string;
      appFallbackUrl?: string;
    },
  ): Promise<string> {
    const directUrl = this.extractFirstUrl(deployResult);
    if (directUrl) return directUrl;
    const fallbackUrl = this.normalizePublicUrl(appFallbackUrl);

    let revisionId = typeof deployResult?.id === "string"
      ? deployResult.id
      : "";
    let lastRevisionStatus = "";
    this.debugLog("Resolving deploy URL", {
      appId,
      revisionId: revisionId || "unknown",
      timeoutMs: this.urlResolutionTimeoutMs,
      softTimeoutMs: this.urlResolutionSoftTimeoutMs,
      fallbackUrl: fallbackUrl || undefined,
    });
    const donePromise = deployResult?.done &&
        typeof deployResult.done.then === "function"
      ? Promise.resolve(deployResult.done)
      : null;

    if (donePromise) {
      try {
        const doneTimeoutMs = Math.min(this.urlResolutionTimeoutMs, 10_000);
        const revision = await this.awaitWithTimeout(
          donePromise,
          doneTimeoutMs,
          `Timed out waiting for revision completion after ${doneTimeoutMs}ms`,
        );
        if (typeof revision?.id === "string" && revision.id.length > 0) {
          revisionId = revision.id;
        }
        if (typeof revision?.status === "string") {
          lastRevisionStatus = revision.status;
          this.debugLog("Revision status from done()", {
            appId,
            revisionId: revisionId || "unknown",
            status: lastRevisionStatus,
          });
        }
        const revisionUrl = this.extractFirstUrl(revision) ??
          this.extractUrlFromRevision(revision);
        if (revisionUrl) return revisionUrl;
        if (
          this.isTerminalFailureStatus(
            typeof revision?.status === "string" ? revision.status : undefined,
          )
        ) {
          const logTail = await this.collectDeployLogTail({
            deployResult,
            client,
            revisionId,
          });
          const revisionSummary = this.summarizeRevision(revision);
          throw new Error(
            `Deployment revision ${
              revisionId || "(unknown)"
            } failed with status ${revision.status} before URL assignment.${
              logTail ? ` Logs: ${logTail}` : ""
            }${revisionSummary ? ` Revision: ${revisionSummary}` : ""}`,
          );
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!message.toLowerCase().includes("timed out")) {
          throw new Error(`Build failed before URL assignment: ${message}`);
        }
      }
    }

    const deadline = Date.now() + this.urlResolutionTimeoutMs;
    const softDeadline = Date.now() + this.urlResolutionSoftTimeoutMs;
    let lastLoggedStatus = lastRevisionStatus;
    let pollCount = 0;
    while (Date.now() < deadline) {
      pollCount += 1;
      if (
        revisionId.length > 0 &&
        client?.revisions &&
        typeof client.revisions.get === "function"
      ) {
        try {
          const refreshedRevision = await client.revisions.get(revisionId);
          if (typeof refreshedRevision?.status === "string") {
            lastRevisionStatus = refreshedRevision.status;
            if (lastRevisionStatus !== lastLoggedStatus) {
              lastLoggedStatus = lastRevisionStatus;
              this.debugLog("Revision status changed", {
                appId,
                revisionId,
                status: lastRevisionStatus,
              });
            }
          }
          const refreshedUrl = this.extractFirstUrl(refreshedRevision) ??
            this.extractUrlFromRevision(refreshedRevision);
          if (refreshedUrl) return refreshedUrl;
          if (
            this.isTerminalFailureStatus(
              typeof refreshedRevision?.status === "string"
                ? refreshedRevision.status
                : undefined,
            )
          ) {
            const logTail = await this.collectDeployLogTail({
              deployResult,
              client,
              revisionId,
            });
            const revisionSummary = this.summarizeRevision(refreshedRevision);
            throw new Error(
              `Deployment revision ${revisionId} failed with status ${refreshedRevision.status} before URL assignment.${
                logTail ? ` Logs: ${logTail}` : ""
              }${revisionSummary ? ` Revision: ${revisionSummary}` : ""}`,
            );
          }
        } catch (error) {
          if (
            error instanceof Error &&
            error.message.startsWith("Deployment revision ")
          ) {
            throw error;
          }
          const message = error instanceof Error
            ? error.message
            : String(error);
          throw new Error(`Failed to inspect deployment revision: ${message}`);
        }
      }

      const timelineUrl = await this.tryGetTimelineUrl(client, appId);
      if (timelineUrl) return timelineUrl;

      const appUrl = await this.tryGetAppUrl(client, appId);
      if (appUrl) return appUrl;

      if (
        fallbackUrl &&
        Date.now() >= softDeadline &&
        !this.isTerminalFailureStatus(lastRevisionStatus || undefined)
      ) {
        this.debugLog("Using fallback app URL while revision still pending", {
          appId,
          revisionId: revisionId || "unknown",
          lastRevisionStatus: lastRevisionStatus || "unknown",
          fallbackUrl,
        });
        return fallbackUrl;
      }

      if (pollCount % 5 === 0) {
        this.debugLog("URL resolution still pending", {
          appId,
          revisionId: revisionId || "unknown",
          pollCount,
          lastRevisionStatus: lastRevisionStatus || "unknown",
          msRemaining: Math.max(0, deadline - Date.now()),
        });
      }

      await new Promise((resolve) =>
        setTimeout(resolve, URL_RESOLUTION_POLL_MS)
      );
    }

    const timeoutLogTail = await this.collectDeployLogTail({
      deployResult,
      client,
      revisionId: revisionId || undefined,
      maxEntries: 30,
      idleTimeoutMs: 1_500,
      totalTimeoutMs: 8_000,
    });
    if (
      fallbackUrl &&
      !this.isTerminalFailureStatus(lastRevisionStatus || undefined)
    ) {
      this.debugLog("Hard timeout reached; returning fallback app URL", {
        appId,
        revisionId: revisionId || "unknown",
        lastRevisionStatus: lastRevisionStatus || "unknown",
        fallbackUrl,
        timeoutMs: this.urlResolutionTimeoutMs,
      });
      return fallbackUrl;
    }
    const timeoutHint = (lastRevisionStatus || "").toLowerCase() === "building"
      ? " Revision remained in building; consider increasing PREVIEW_URL_RESOLUTION_TIMEOUT_MS."
      : "";
    throw new Error(
      `Deployment completed without a public URL after ${this.urlResolutionTimeoutMs}ms (appId=${appId}, revisionId=${
        revisionId || "unknown"
      }, lastRevisionStatus=${
        lastRevisionStatus || "unknown"
      }). Checked: deploy.done, revisions.get, timelines.list, apps.get.${timeoutHint}${
        timeoutLogTail ? ` Recent logs: ${timeoutLogTail}` : ""
      }`,
    );
  }

  private async safeDeleteApp(client: any, appId: string) {
    try {
      if (client?.apps && typeof client.apps.delete === "function") {
        await client.apps.delete(appId);
        return;
      }
      if (client?.apps && typeof client.apps.remove === "function") {
        await client.apps.remove(appId);
      }
    } catch {
      // Ignore provider teardown errors in best-effort cleanup.
    }
  }

  private async safeDisposeSandbox(sandbox: any) {
    if (!sandbox) return;

    // close() can just disconnect; terminate the sandbox first if possible.
    if (typeof sandbox.kill === "function") {
      try {
        await sandbox.kill();
      } catch {
        // Ignore kill errors and continue with best-effort cleanup.
      }
    } else if (typeof sandbox.delete === "function") {
      try {
        await sandbox.delete();
      } catch {
        // Ignore delete errors and continue with best-effort cleanup.
      }
    } else if (typeof sandbox.stop === "function") {
      try {
        await sandbox.stop();
      } catch {
        // Ignore stop errors and continue with best-effort cleanup.
      }
    }

    if (typeof sandbox.close === "function") {
      try {
        await sandbox.close();
      } catch {
        // Ignore close errors.
      }
    }
  }
}
