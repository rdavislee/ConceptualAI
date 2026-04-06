// @ts-ignore: Deno is available at runtime
declare const Deno: any;

import { Buffer } from "node:buffer";
import { resolveSrv, resolveTxt } from "node:dns/promises";
import { Freestyle, Vm } from "npm:freestyle-sandboxes";
import {
  PreviewLaunchInput,
  PreviewLaunchOutput,
  PreviewProvider,
  PreviewTeardownInput,
} from "./types.ts";

const FRONTEND_INTERNAL_PORT = 5173;
const FRONTEND_GATEWAY_INTERNAL_PORT = 3000;
const BACKEND_INTERNAL_PORT = 8000;
const FRONTEND_EXTERNAL_PORT = 443;
const BACKEND_EXTERNAL_PORT = 8081;
const BACKEND_SERVICE_NAME = "preview-backend";
const FRONTEND_SERVICE_NAME = "preview-frontend";
const FRONTEND_GATEWAY_SERVICE_NAME = "preview-frontend-gateway";
const PREVIEW_FRONTEND_API_BASE = "/api";
const SERVICE_PATH =
  "/root/.deno/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const DEFAULT_MEMORY_MB = 1024;
const DEFAULT_HTTP_PROBE_TIMEOUT_MS = 120_000;
const DEFAULT_BACKEND_HTTP_PROBE_TIMEOUT_MS = 60_000;
const HTTP_PROBE_INTERVAL_MS = 2_000;
const HTTP_PROBE_REQUEST_TIMEOUT_MS = 8_000;
const DEFAULT_LOCAL_PROBE_TIMEOUT_MS = 180_000;
const DEFAULT_EXEC_TIMEOUT_MS = 120_000;
const EXEC_TIMEOUT_GRACE_MS = 5_000;
const LOCAL_PROBE_POLL_MS = 1_500;
const LOCAL_PROBE_PROGRESS_EVERY = 10;
const LOCAL_PROBE_FATAL_CHECK_EVERY = 3;
const SPAWN_FALLBACK_TIMEOUT_MS = 15_000;
const FATAL_BACKEND_LOG_PATTERNS: RegExp[] = [
  /MongoDB connection failed:[^\n]*/i,
  /MongoServerSelectionError:[^\n]*/i,
  /error:\s*Uncaught[^\n]*/i,
  /EADDRINUSE/i,
];

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function clipText(
  value: string | null | undefined,
  max = 1600,
  mode: "start" | "end" | "both" = "both",
): string {
  const text = (value || "").trim();
  if (!text) return "";
  if (text.length <= max) return text;
  if (mode === "start") {
    return `${text.slice(0, max)}...<truncated>`;
  }
  if (mode === "end") {
    return `...<truncated>${text.slice(-max)}`;
  }
  const headLength = Math.max(200, Math.floor(max / 2));
  const tailLength = Math.max(200, max - headLength);
  return `${text.slice(0, headLength)}\n...<truncated>...\n${text.slice(-tailLength)}`;
}

export class FreestylePreviewProvider implements PreviewProvider {
  private readonly apiKey = Deno.env.get("FREESTYLE_API_KEY")?.trim() ?? "";
  private readonly debug = Deno.env.get("PREVIEW_DEBUG") === "1";
  private readonly probeTimeoutMs = parsePositiveInt(
    Deno.env.get("PREVIEW_FREESTYLE_HTTP_TIMEOUT_MS"),
    DEFAULT_HTTP_PROBE_TIMEOUT_MS,
  );
  private readonly backendProbeTimeoutMs = parsePositiveInt(
    Deno.env.get("PREVIEW_FREESTYLE_BACKEND_HTTP_TIMEOUT_MS"),
    DEFAULT_BACKEND_HTTP_PROBE_TIMEOUT_MS,
  );
  private readonly probeRequestTimeoutMs = parsePositiveInt(
    Deno.env.get("PREVIEW_FREESTYLE_HTTP_REQUEST_TIMEOUT_MS"),
    HTTP_PROBE_REQUEST_TIMEOUT_MS,
  );
  private readonly localProbeTimeoutMs = parsePositiveInt(
    Deno.env.get("PREVIEW_FREESTYLE_LOCAL_PROBE_TIMEOUT_MS"),
    DEFAULT_LOCAL_PROBE_TIMEOUT_MS,
  );
  private readonly execTimeoutMs = parsePositiveInt(
    Deno.env.get("PREVIEW_FREESTYLE_EXEC_TIMEOUT_MS"),
    DEFAULT_EXEC_TIMEOUT_MS,
  );

  private debugLog(message: string, data?: Record<string, unknown>) {
    if (!this.debug) return;
    if (data) {
      console.log(`[Previewing:Freestyle] ${message}`, data);
      return;
    }
    console.log(`[Previewing:Freestyle] ${message}`);
  }

  async launch(input: PreviewLaunchInput): Promise<PreviewLaunchOutput> {
    if (!this.apiKey) {
      throw new Error(
        "FREESTYLE_API_KEY is not configured. Please add it to your .env file.",
      );
    }

    const fs = new Freestyle({ apiKey: this.apiKey });
    let vm: Vm | null = null;
    let vmId: string | undefined;
    let backendServiceId: string | null = null;
    let frontendServiceId: string | null = null;

    try {
      const preparedBackendEnv = await this.prepareBackendEnv(
        input.backendEnv || {},
      );
      const backendEnv = this.buildBackendRuntimeEnv(preparedBackendEnv);
      this.debugLog("Launch started", {
        project: input.project,
        launchId: input.launchId,
      });

      this.debugLog("Creating Freestyle VM", {
        memoryMb: DEFAULT_MEMORY_MB,
      });
      const createRes = await fs.vms.create({
        memoryMb: DEFAULT_MEMORY_MB,
        ports: [
          {
            port: FRONTEND_EXTERNAL_PORT,
            targetPort: FRONTEND_GATEWAY_INTERNAL_PORT,
          },
          { port: BACKEND_EXTERNAL_PORT, targetPort: BACKEND_INTERNAL_PORT },
        ],
      } as any);

      vm = createRes.vm as unknown as Vm;

      if (!vm) {
        throw new Error("VM creation returned null.");
      }
      vmId = vm.vmId;
      this.debugLog("VM created", { vmId });
      const domainCandidates = await this.resolveDomainCandidates(
        vm,
        vmId,
        createRes,
      );
      this.debugLog("Resolved domain candidates", { domainCandidates });

      this.debugLog("Uploading artifact zips to VM...");
      await this.runBashChecked(vm, "mkdir -p /project", "Create project root");
      await this.uploadBinaryFile(
        vm,
        "/project/backend.zip",
        input.backendZip,
        "Upload backend zip",
      );
      await this.uploadBinaryFile(
        vm,
        "/project/frontend.zip",
        input.frontendZip,
        "Upload frontend zip",
      );

      this.debugLog("Extracting zips on the remote VM...");
      const remoteBackendPath = "/project/backend";
      const remoteFrontendPath = "/project/frontend";

      await this.runBashChecked(
        vm,
        `mkdir -p ${remoteBackendPath} && unzip -q /project/backend.zip -d ${remoteBackendPath}`,
        "Extract backend",
        { timeoutMs: 180_000 },
      );
      await this.runBashChecked(
        vm,
        `mkdir -p ${remoteFrontendPath} && unzip -q /project/frontend.zip -d ${remoteFrontendPath}`,
        "Extract frontend",
        { timeoutMs: 180_000 },
      );

      this.debugLog("Ensuring preview runtimes are available");
      await this.ensureRuntimeDependencies(vm);

      this.debugLog("Installing backend dependencies");
      await this.runBashChecked(
        vm,
        `cd ${remoteBackendPath} && if [ -f package-lock.json ]; then npm ci; elif [ -f package.json ]; then npm install; else echo "No backend package.json, skipping npm install."; fi`,
        "Install backend dependencies",
        { timeoutMs: 900_000 },
      );

      this.debugLog("Preparing backend imports");
      await this.runBashChecked(
        vm,
        `cd ${remoteBackendPath} && (deno task build || deno run --allow-read --allow-write --allow-env src/utils/generate_imports.ts)`,
        "Generate backend imports",
        { timeoutMs: 300_000 },
      );
      this.debugLog("Priming backend runtime cache");
      await this.runBashChecked(
        vm,
        `cd ${remoteBackendPath} && deno cache src/main.ts`,
        "Prime backend runtime cache",
        { timeoutMs: 600_000 },
      );

      this.debugLog("Installing frontend dependencies");
      await this.runBashChecked(
        vm,
        `cd ${remoteFrontendPath} && if [ -f package-lock.json ]; then npm ci; else npm install; fi`,
        "Install frontend dependencies",
        { timeoutMs: 900_000 },
      );
      this.debugLog("Building frontend");
      await this.runBashChecked(
        vm,
        `cd ${remoteFrontendPath} && VITE_API_URL=${
          this.shellQuote(PREVIEW_FRONTEND_API_BASE)
        } npm run build`,
        "Build frontend",
        { timeoutMs: 900_000 },
      );

      this.debugLog("Starting backend daemon...");
      try {
        backendServiceId = await this.createAndStartSystemdService(
          vm,
          {
            name: BACKEND_SERVICE_NAME,
            workdir: remoteBackendPath,
            env: backendEnv,
            command: "deno task start",
            label: "backend",
          },
        );
        this.debugLog("Backend systemd service started", { backendServiceId });
      } catch (error) {
        this.debugLog("Backend systemd service failed; falling back to spawn", {
          error: error instanceof Error ? error.message : String(error),
        });
        await this.spawnDetachedProcess(
          vm,
          {
            workdir: remoteBackendPath,
            env: backendEnv,
            command: "deno task start",
            logPath: "/project/backend.log",
            label: "backend",
          },
        );
        backendServiceId = null;
        this.debugLog("Backend spawned via fallback command");
      }
      await this.waitForLocalService(
        vm,
        `http://127.0.0.1:${BACKEND_INTERNAL_PORT}/`,
        "backend",
        this.localProbeTimeoutMs,
        backendServiceId,
        "/project/backend.log",
      );
      this.debugLog("Backend local probe succeeded");

      const refreshedDomainCandidates = await this.resolveDomainCandidates(
        vm,
        vmId,
        createRes,
      );
      this.debugLog("Refreshed domain candidates", {
        domainCandidates: refreshedDomainCandidates,
      });

      const frontendAllowedHost = this.selectPreferredDomain(
        refreshedDomainCandidates,
      );
      const frontendEnv = {
        ...(frontendAllowedHost
          ? {
            __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS: frontendAllowedHost,
          }
          : {}),
      };

      this.debugLog("Starting frontend daemon...");
      try {
        frontendServiceId = await this.createAndStartSystemdService(
          vm,
          {
            name: FRONTEND_SERVICE_NAME,
            workdir: remoteFrontendPath,
            env: frontendEnv,
            command: this.getFrontendServeCommand(),
            label: "frontend",
          },
        );
        this.debugLog("Frontend systemd service started", {
          frontendServiceId,
        });
      } catch (error) {
        this.debugLog(
          "Frontend systemd service failed; falling back to spawn",
          {
            error: error instanceof Error ? error.message : String(error),
          },
        );
        await this.spawnDetachedProcess(
          vm,
          {
            workdir: remoteFrontendPath,
            env: frontendEnv,
            command: this.getFrontendServeCommand(),
            logPath: "/project/frontend.log",
            label: "frontend",
          },
        );
        frontendServiceId = null;
        this.debugLog("Frontend spawned via fallback command");
      }
      await this.waitForLocalService(
        vm,
        `http://127.0.0.1:${FRONTEND_INTERNAL_PORT}/`,
        "frontend",
        this.localProbeTimeoutMs,
        frontendServiceId,
      );
      this.debugLog("Frontend local probe succeeded");

      this.debugLog("Starting frontend gateway daemon...");
      await this.startFrontendGateway(
        vm,
        remoteFrontendPath,
        frontendAllowedHost,
      );
      await this.waitForLocalService(
        vm,
        `http://127.0.0.1:${FRONTEND_GATEWAY_INTERNAL_PORT}/`,
        "frontend gateway",
        this.localProbeTimeoutMs,
        FRONTEND_GATEWAY_SERVICE_NAME,
        "/project/frontend-gateway.log",
      );
      this.debugLog("Frontend gateway local probe succeeded");
      await this.waitForLocalService(
        vm,
        `http://127.0.0.1:${FRONTEND_GATEWAY_INTERNAL_PORT}${PREVIEW_FRONTEND_API_BASE}`,
        "backend gateway",
        this.localProbeTimeoutMs,
        FRONTEND_GATEWAY_SERVICE_NAME,
        "/project/frontend-gateway.log",
      );
      this.debugLog("Backend gateway local probe succeeded");

      const frontendPublicUrl = await this.waitForPublicUrl({
        domains: refreshedDomainCandidates,
        externalPort: FRONTEND_EXTERNAL_PORT,
        probePath: "/",
        label: "frontend",
        timeoutMs: this.probeTimeoutMs,
      });
      const backendRoutedUrl = `${frontendPublicUrl.replace(/\/+$/, "")}/api`;

      this.debugLog("Preview successfully launched on Freestyle VM", {
        backendUrl: backendRoutedUrl,
        frontendUrl: frontendPublicUrl,
      });

      return {
        backendAppId: String(vmId),
        backendUrl: backendRoutedUrl,
        frontendAppId: String(vmId),
        frontendUrl: frontendPublicUrl,
      };
    } catch (error) {
      this.debugLog("Error during freestyle launch", {
        error: error instanceof Error ? error.message : String(error),
      });
      if (vm) {
        const [backendLog, frontendLog, backendSystemdLog, frontendSystemdLog] =
          await Promise.all([
            this.readRemoteLog(vm, "/project/backend.log"),
            this.readRemoteLog(vm, "/project/frontend.log"),
            this.readSystemdLog(vm, backendServiceId),
            this.readSystemdLog(vm, frontendServiceId),
          ]);
        this.debugLog("Backend log snippet", { backendLog });
        this.debugLog("Frontend log snippet", { frontendLog });
        this.debugLog("Backend systemd log snippet", {
          backendServiceId,
          backendSystemdLog,
        });
        this.debugLog("Frontend systemd log snippet", {
          frontendServiceId,
          frontendSystemdLog,
        });
        if (
          input.backendEnv?.MONGODB_URL &&
          (
            backendLog.includes("MongoDB connection failed:") ||
            (error instanceof Error &&
              error.message.includes("MongoDB connection failed:"))
          )
        ) {
          const mongoDiagnostics = await this.readMongoDiagnostics(
            vm,
            input.backendEnv.MONGODB_URL,
          );
          this.debugLog("Mongo connectivity diagnostics", {
            mongoDiagnostics,
          });
        }
        try {
          await (fs as any).vms.delete({ vmId });
        } catch {
          // Ignore teardown failure on error path.
        }
      }
      throw error;
    }
  }

  async teardown(input: PreviewTeardownInput): Promise<void> {
    const vmId = input.backendAppId || input.frontendAppId;
    if (!vmId || !this.apiKey) {
      this.debugLog("Skipping Freestyle teardown", {
        vmId,
        hasApiKey: this.apiKey.length > 0,
      });
      return;
    }

    const fs = new Freestyle({ apiKey: this.apiKey });
    try {
      this.debugLog("Deleting Freestyle VM", {
        vmId,
        backendAppId: input.backendAppId,
        frontendAppId: input.frontendAppId,
      });
      await (fs as any).vms.delete({ vmId });
      this.debugLog(`Tore down VM ${vmId}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.debugLog(`Failed to tear down VM ${vmId}`, { error: message });
      throw new Error(`Failed to tear down Freestyle VM ${vmId}: ${message}`);
    }
  }

  private buildExportPrefix(env: Record<string, string>): string {
    const pairs = Object.entries(env);
    if (pairs.length === 0) return "";
    const exports = pairs.map(([key, value]) =>
      `export ${key}='${value.replace(/'/g, "'\\''")}'`
    );
    return `${exports.join(" && ")} && `;
  }

  private buildBackendRuntimeEnv(
    env: Record<string, string>,
  ): Record<string, string> {
    return {
      DENO_TLS_CA_STORE: "mozilla,system",
      ...env,
    };
  }

  private async prepareBackendEnv(
    env: Record<string, string>,
  ): Promise<Record<string, string>> {
    if (!env.MONGODB_URL) return { ...env };
    const normalizedMongoUrl = await this.expandMongoSrvUrl(env.MONGODB_URL);
    if (normalizedMongoUrl === env.MONGODB_URL) return { ...env };

    this.debugLog("Expanded preview Mongo SRV URL for backend runtime", {
      mongoHosts: this.getMongoConnectionHosts(normalizedMongoUrl),
    });
    return {
      ...env,
      MONGODB_URL: normalizedMongoUrl,
    };
  }

  private getMongoConnectionHosts(mongoUrl: string): string[] {
    try {
      const url = new URL(mongoUrl);
      return url.host.split(",").map((entry) => entry.trim()).filter(Boolean);
    } catch {
      return [];
    }
  }

  private async expandMongoSrvUrl(mongoUrl: string): Promise<string> {
    let parsed: URL;
    try {
      parsed = new URL(mongoUrl);
    } catch {
      return mongoUrl;
    }

    if (parsed.protocol !== "mongodb+srv:") return mongoUrl;

    const srvHost = parsed.hostname;
    if (!srvHost) return mongoUrl;

    const srvRecords = await this.resolveMongoSrvRecords(srvHost);
    if (!Array.isArray(srvRecords) || srvRecords.length === 0) {
      return mongoUrl;
    }

    const hosts = srvRecords.map((record) => `${record.name}:${record.port}`);
    const params = new URLSearchParams(parsed.search);
    for (const [key, value] of await this.resolveMongoTxtParams(srvHost)) {
      if (!params.has(key)) {
        params.set(key, value);
      }
    }
    if (!params.has("tls") && !params.has("ssl")) {
      params.set("tls", "true");
    }
    if (!params.has("connectTimeoutMS")) {
      params.set("connectTimeoutMS", "5000");
    }

    const authPrefix = parsed.username
      ? `${encodeURIComponent(parsed.username)}${
        parsed.password ? `:${encodeURIComponent(parsed.password)}` : ""
      }@`
      : "";
    const path = parsed.pathname && parsed.pathname !== "/"
      ? parsed.pathname
      : "";
    const query = params.toString();
    return `mongodb://${authPrefix}${hosts.join(",")}${path}${
      query ? `?${query}` : ""
    }`;
  }

  private async resolveMongoSrvRecords(hostname: string): Promise<
    Array<{ name: string; port: number }>
  > {
    try {
      return await resolveSrv(`_mongodb._tcp.${hostname}`);
    } catch {
      return [];
    }
  }

  private async resolveMongoTxtParams(
    hostname: string,
  ): Promise<Array<[string, string]>> {
    try {
      const records = await resolveTxt(hostname);
      const pairs: Array<[string, string]> = [];
      for (const record of records) {
        const combined = record.join("").trim();
        if (!combined) continue;
        for (const segment of combined.split("&")) {
          const trimmed = segment.trim();
          if (!trimmed) continue;
          const separatorIndex = trimmed.indexOf("=");
          if (separatorIndex <= 0) continue;
          pairs.push([
            trimmed.slice(0, separatorIndex),
            trimmed.slice(separatorIndex + 1),
          ]);
        }
      }
      return pairs;
    } catch {
      return [];
    }
  }

  private async createAndStartSystemdService(
    vm: Vm,
    {
      name,
      workdir,
      env,
      command,
      label,
    }: {
      name: string;
      workdir: string;
      env: Record<string, string>;
      command: string;
      label: string;
    },
  ): Promise<string> {
    const serviceEnv = {
      ...env,
      PATH: SERVICE_PATH,
    };
    const createResult = await vm.systemd.create({
      name,
      mode: "service",
      exec: this.buildSystemdExecCommand(command),
      env: serviceEnv,
      workdir,
      restartPolicy: {
        policy: "on-failure",
        restartSec: 2,
        startLimitBurst: 5,
      },
      timeoutSec: 120,
      enable: true,
    } as any);

    const candidates = [
      (createResult as any)?.serviceName as string | undefined,
      `${name}.service`,
      name,
    ].filter((v): v is string => !!v && v.trim().length > 0);

    let lastError = "";
    for (const serviceId of candidates) {
      try {
        const startResult = await vm.systemd.start({
          services: [{ id: serviceId }],
        } as any);
        const first = (startResult as any)?.results?.[0];
        if (!first || first.success) return serviceId;
        const message = String(first.message || "");
        if (
          message.toLowerCase().includes("already") ||
          message.toLowerCase().includes("running")
        ) {
          return serviceId;
        }
        lastError = `${serviceId}: ${message || "unknown start failure"}`;
      } catch (error) {
        lastError = `${serviceId}: ${
          error instanceof Error ? error.message : String(error)
        }`;
      }

      try {
        const status = await vm.systemd.getStatus({
          serviceId,
        } as any);
        const active = String((status as any)?.activeState || "").toLowerCase();
        const sub = String((status as any)?.subState || "").toLowerCase();
        if (active === "active" || sub === "running") {
          return serviceId;
        }
        lastError = `${serviceId}: activeState=${
          active || "unknown"
        } subState=${sub || "unknown"}`;
      } catch (error) {
        lastError = `${serviceId}: status check failed (${
          error instanceof Error ? error.message : String(error)
        })`;
      }
    }

    throw new Error(
      `Failed to start ${label} systemd service "${name}". ${
        lastError || "No service identifier worked."
      }`,
    );
  }

  private buildSystemdExecCommand(command: string): string[] {
    return [
      "/bin/bash",
      "-lc",
      `export PATH=${this.shellQuote(SERVICE_PATH)} && exec ${command}`,
    ];
  }

  private async spawnDetachedProcess(
    vm: Vm,
    {
      workdir,
      env,
      command,
      logPath,
      label,
    }: {
      workdir: string;
      env: Record<string, string>;
      command: string;
      logPath: string;
      label: string;
    },
  ): Promise<void> {
    const envPrefix = this.buildExportPrefix({
      ...env,
      PATH: SERVICE_PATH,
    });
    const spawnCommand = `${envPrefix}cd ${
      this.shellQuote(workdir)
    } && nohup ${command} > ${
      this.shellQuote(logPath)
    } 2>&1 < /dev/null & echo "__spawned__"`;

    const execPromise = vm.exec({
      command: `bash -lc ${this.shellQuote(spawnCommand)}`,
      timeoutMs: SPAWN_FALLBACK_TIMEOUT_MS,
    });

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        timedOut = true;
        reject(
          new Error(
            `${label} spawn fallback timed out after ${SPAWN_FALLBACK_TIMEOUT_MS}ms`,
          ),
        );
      }, SPAWN_FALLBACK_TIMEOUT_MS + EXEC_TIMEOUT_GRACE_MS);
    });

    try {
      const result = await Promise.race([execPromise, timeoutPromise]) as any;
      const exitCode = Number(result?.statusCode ?? 0);
      if (exitCode !== 0) {
        const stdout = clipText(result?.stdout, 2000, "both");
        const stderr = clipText(result?.stderr, 4000, "both");
        throw new Error(
          `${label} spawn fallback failed (exit=${exitCode}). stdout=${
            stdout || "<empty>"
          } stderr=${stderr || "<empty>"}`,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("timed out")) {
        this.debugLog(`${label} spawn fallback timed out; continuing`, {
          error: message,
        });
        return;
      }
      throw error;
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
      if (timedOut) {
        execPromise.catch(() => {
          // Ignore eventual completion/rejection after timeout escape.
        });
      }
    }
  }

  private normalizeDomain(raw: unknown): string | null {
    if (typeof raw !== "string") return null;
    const trimmed = raw.trim();
    if (!trimmed) return null;
    try {
      const asUrl = new URL(trimmed);
      const host = asUrl.host.trim();
      return host.length > 0 ? host : null;
    } catch {
      const host = trimmed
        .replace(/^https?:\/\//i, "")
        .replace(/\/.*$/, "")
        .trim();
      return host.length > 0 ? host : null;
    }
  }

  private async uploadBinaryFile(
    vm: Vm,
    remotePath: string,
    bytes: Uint8Array,
    label: string,
  ): Promise<void> {
    const base64Path = `${remotePath}.b64`;
    const base64Content = Buffer.from(bytes).toString("base64");
    this.debugLog(`${label}: staging base64 upload`, {
      remotePath,
      bytes: bytes.byteLength,
      base64Bytes: base64Content.length,
    });
    await (vm.fs as any).writeTextFile(base64Path, base64Content);

    const remotePathQuoted = this.shellQuote(remotePath);
    const base64PathQuoted = this.shellQuote(base64Path);
    await this.runBashChecked(
      vm,
      `(base64 -d ${base64PathQuoted} > ${remotePathQuoted} || base64 --decode ${base64PathQuoted} > ${remotePathQuoted}) && test -s ${remotePathQuoted} && rm -f ${base64PathQuoted}`,
      `${label}: decode base64`,
    );
  }

  private async ensureRuntimeDependencies(vm: Vm): Promise<void> {
    await this.runBashChecked(
      vm,
      `
set -e
export PATH="$HOME/.deno/bin:$PATH"
if ! command -v deno >/dev/null 2>&1; then
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL https://deno.land/install.sh | sh -s -- -y
  elif command -v wget >/dev/null 2>&1; then
    wget -qO- https://deno.land/install.sh | sh -s -- -y
  else
    echo "Neither curl nor wget is available to install Deno." >&2
    exit 1
  fi
fi
deno --version >/dev/null
DENO_BIN="$(command -v deno || true)"
if [ -n "$DENO_BIN" ]; then
  mkdir -p /usr/local/bin
  ln -sf "$DENO_BIN" /usr/local/bin/deno || true
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required for frontend previews but is not installed." >&2
  exit 1
fi
`,
      "Ensure runtime dependencies",
      { timeoutMs: 300_000 },
    );
  }

  private async resolveDomainCandidates(
    vm: Vm,
    vmId: string,
    createRes: any,
  ): Promise<string[]> {
    const domains = new Set<string>();
    const createDomainsRaw = Array.isArray(createRes?.domains)
      ? createRes.domains
      : [];
    for (const raw of createDomainsRaw) {
      const domain = this.normalizeDomain(raw);
      if (domain) domains.add(domain);
    }

    let startedDomainsRaw: unknown[] = [];
    try {
      const started = await vm.start();
      startedDomainsRaw = Array.isArray(started?.domains)
        ? started.domains
        : [];
      for (const raw of startedDomainsRaw) {
        const domain = this.normalizeDomain(raw);
        if (domain) domains.add(domain);
      }
    } catch (error) {
      this.debugLog("vm.start() for domain discovery failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    const fallbackDomains = [
      `${vmId}.vm.freestyle.sh`,
      `${vmId}.vm.freestyle.it.com`,
    ];
    for (const fallback of fallbackDomains) {
      const domain = this.normalizeDomain(fallback);
      if (domain) domains.add(domain);
    }

    this.debugLog("Domain discovery details", {
      vmId,
      createDomainsRaw,
      startedDomainsRaw,
      fallbackDomains,
      mergedDomains: Array.from(domains),
    });

    if (domains.size === 0) {
      throw new Error(
        "Could not resolve a public domain for the Freestyle VM.",
      );
    }

    return Array.from(domains);
  }

  private async waitForLocalService(
    vm: Vm,
    url: string,
    label: string,
    timeoutMs: number,
    serviceId?: string | null,
    logPathForFatalDetection?: string,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    const urlQuoted = this.shellQuote(url);
    const probeCommand = `
if command -v curl >/dev/null 2>&1; then
  code="$(curl -sS -o /dev/null -w "%{http_code}" --max-time 3 ${urlQuoted} || true)"
  if [ -z "$code" ] || [ "$code" = "000" ]; then
    echo "curl could not reach ${url}" >&2
    exit 7
  fi
elif command -v wget >/dev/null 2>&1; then
  wget -q -T 3 -O /dev/null ${urlQuoted} || exit $?
else
  echo "Neither curl nor wget is available for local probe." >&2
  exit 127
fi
`;

    let attempt = 0;
    let lastError = "";
    while (Date.now() < deadline) {
      attempt += 1;
      try {
        await this.runBashChecked(
          vm,
          probeCommand,
          `Probe local ${label} service`,
          { timeoutMs: 12_000 },
        );
        return;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }

      if (
        logPathForFatalDetection &&
        attempt % LOCAL_PROBE_FATAL_CHECK_EVERY === 0
      ) {
        const logSnippet = await this.readRemoteLog(
          vm,
          logPathForFatalDetection,
        );
        const fatalReason = this.detectFatalStartupIssue(logSnippet);
        if (fatalReason) {
          throw new Error(
            `${label} startup failed: ${fatalReason}`,
          );
        }
      }

      if (attempt % LOCAL_PROBE_PROGRESS_EVERY === 0) {
        this.debugLog(`${label} local probe pending`, {
          attempt,
          remainingMs: Math.max(0, deadline - Date.now()),
          lastError,
          serviceId: serviceId || null,
        });
        if (serviceId) {
          try {
            const status = await vm.systemd.getStatus({ serviceId } as any);
            const activeState = String((status as any)?.activeState || "")
              .toLowerCase();
            const subState = String((status as any)?.subState || "")
              .toLowerCase();
            this.debugLog(`${label} systemd status`, {
              serviceId,
              activeState: activeState || null,
              subState: subState || null,
              loadState: (status as any)?.loadState ?? null,
            });
            if (
              attempt > 2 &&
              (
                activeState === "failed" ||
                (activeState === "inactive" &&
                  (subState === "dead" || subState === "exited" ||
                    subState === "failed"))
              )
            ) {
              const serviceLogs = await this.readSystemdLog(vm, serviceId);
              const fatalReason = this.detectFatalStartupIssue(serviceLogs);
              throw new Error(
                `${label} service ${serviceId} exited before readiness (activeState=${activeState}, subState=${subState})${
                  fatalReason ? `. ${fatalReason}` : ""
                }`,
              );
            }
          } catch (statusError) {
            this.debugLog(`${label} systemd status read failed`, {
              serviceId,
              error: statusError instanceof Error
                ? statusError.message
                : String(statusError),
            });
            if (
              statusError instanceof Error &&
              statusError.message.includes("exited before readiness")
            ) {
              throw statusError;
            }
          }
        }
      }

      await this.sleep(LOCAL_PROBE_POLL_MS);
    }

    throw new Error(
      `${label} local service did not become ready at ${url} within ${timeoutMs}ms. Last error: ${
        lastError || "none"
      }`,
    );
  }

  private buildProbeCandidates(
    domains: string[],
    externalPort: number,
  ): string[] {
    const out = new Set<string>();
    for (const domain of domains) {
      if (externalPort === FRONTEND_EXTERNAL_PORT) {
        out.add(`https://${domain}`);
        out.add(`http://${domain}`);
      } else {
        out.add(`https://${domain}:${externalPort}`);
        out.add(`http://${domain}:${externalPort}`);
      }
    }
    return Array.from(out);
  }

  private selectPreferredDomain(domains: string[]): string | null {
    for (const domain of domains) {
      if (/\.vm\.freestyle\.sh$/i.test(domain)) return domain;
    }
    return domains[0] || null;
  }

  private getFrontendServeCommand(): string {
    return `npx vite preview --host 0.0.0.0 --port ${FRONTEND_INTERNAL_PORT} --strictPort`;
  }

  private buildFrontendGatewayScript(
    frontendAllowedHost: string | null,
  ): string {
    const allowedHostCheck = frontendAllowedHost
      ? `if (requestHost && requestHost !== ${
        JSON.stringify(frontendAllowedHost)
      }) {
    return new Response("Blocked host", { status: 403 });
  }`
      : "";

    return `
const FRONTEND_TARGET = "http://127.0.0.1:${FRONTEND_INTERNAL_PORT}";
const BACKEND_TARGET = "http://127.0.0.1:${BACKEND_INTERNAL_PORT}";

function buildTargetUrl(requestUrl) {
  const source = new URL(requestUrl);
  const base = source.pathname.startsWith("/api") ? BACKEND_TARGET : FRONTEND_TARGET;
  return new URL(source.pathname + source.search, base);
}

Deno.serve({ hostname: "0.0.0.0", port: ${FRONTEND_GATEWAY_INTERNAL_PORT} }, async (request) => {
  const source = new URL(request.url);
  const requestHost = request.headers.get("host")?.split(":")[0] ?? "";
  ${allowedHostCheck}
  if (source.pathname === "/api" || source.pathname === "/api/") {
    return Response.json({
      status: "ok",
      message: "Preview backend gateway is running.",
      basePath: "/api",
    });
  }
  const targetUrl = buildTargetUrl(request.url);
  const target = new URL(targetUrl);
  const headers = new Headers(request.headers);
  headers.set("host", target.host);
  headers.set("x-forwarded-host", request.headers.get("host") ?? "");
  headers.set("x-forwarded-proto", "https");
  headers.set("x-forwarded-port", "443");
  headers.delete("content-length");
  const response = await fetch(target, {
    method: request.method,
    headers,
    body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
    redirect: "manual",
  });
  return new Response(response.body, {
    status: response.status,
    headers: response.headers,
  });
});
`;
  }

  private async startFrontendGateway(
    vm: Vm,
    remoteFrontendPath: string,
    frontendAllowedHost: string | null,
  ): Promise<void> {
    const gatewayScriptPath = "/project/frontend_gateway.ts";
    const gatewayScript = this.buildFrontendGatewayScript(frontendAllowedHost);
    await (vm.fs as any).writeTextFile(gatewayScriptPath, gatewayScript);

    try {
      await this.createAndStartSystemdService(
        vm,
        {
          name: FRONTEND_GATEWAY_SERVICE_NAME,
          workdir: remoteFrontendPath,
          env: {},
          command: `deno run --allow-net ${gatewayScriptPath}`,
          label: "frontend gateway",
        },
      );
      this.debugLog("Frontend gateway systemd service started", {
        frontendGatewayServiceId: FRONTEND_GATEWAY_SERVICE_NAME,
      });
    } catch (error) {
      this.debugLog(
        "Frontend gateway systemd service failed; falling back to spawn",
        {
          error: error instanceof Error ? error.message : String(error),
        },
      );
      await this.spawnDetachedProcess(
        vm,
        {
          workdir: remoteFrontendPath,
          env: {},
          command: `deno run --allow-net ${gatewayScriptPath}`,
          logPath: "/project/frontend-gateway.log",
          label: "frontend gateway",
        },
      );
      this.debugLog("Frontend gateway spawned via fallback command");
    }
  }

  private async waitForPublicUrl(
    {
      domains,
      externalPort,
      probePath,
      label,
      timeoutMs,
    }: {
      domains: string[];
      externalPort: number;
      probePath: string;
      label: string;
      timeoutMs: number;
    },
  ): Promise<string> {
    const candidates = this.buildProbeCandidates(domains, externalPort);
    const startedAt = Date.now();
    let lastError = "";

    while ((Date.now() - startedAt) < timeoutMs) {
      for (const baseUrl of candidates) {
        const probeUrl = `${baseUrl.replace(/\/+$/, "")}${probePath}`;
        let timeoutId: ReturnType<typeof setTimeout> | undefined;
        try {
          const controller = new AbortController();
          timeoutId = setTimeout(
            () => controller.abort("probe-timeout"),
            this.probeRequestTimeoutMs,
          );
          const response = await fetch(probeUrl, {
            method: "GET",
            redirect: "manual",
            signal: controller.signal,
          });
          if (response.status > 0 && response.status < 500) {
            this.debugLog(`${label} probe succeeded`, {
              baseUrl,
              probeUrl,
              status: response.status,
            });
            return baseUrl;
          }
          lastError = `${probeUrl} -> status ${response.status}`;
        } catch (error) {
          const errorText = error instanceof Error
            ? error.message
            : String(error);
          lastError = `${probeUrl} -> ${
            errorText.includes("probe-timeout")
              ? `timed out after ${this.probeRequestTimeoutMs}ms`
              : errorText
          }`;
        } finally {
          if (timeoutId) clearTimeout(timeoutId);
        }
      }
      await this.sleep(HTTP_PROBE_INTERVAL_MS);
    }

    throw new Error(
      `Timed out waiting for ${label} endpoint on Freestyle. Candidates: ${
        candidates.join(", ")
      }. Last error: ${lastError || "none"}`,
    );
  }

  private async resolvePublicUrlWithFallback(
    {
      domains,
      externalPort,
      probePath,
      label,
      allowBestEffortFallback,
      timeoutMs,
    }: {
      domains: string[];
      externalPort: number;
      probePath: string;
      label: string;
      allowBestEffortFallback?: boolean;
      timeoutMs: number;
    },
  ): Promise<string> {
    try {
      return await this.waitForPublicUrl({
        domains,
        externalPort,
        probePath,
        label,
        timeoutMs,
      });
    } catch (error) {
      if (!allowBestEffortFallback) throw error;

      const fallbackUrl = this.buildProbeCandidates(domains, externalPort)[0];
      if (!fallbackUrl) throw error;

      const message = error instanceof Error ? error.message : String(error);
      this.debugLog(
        `${label} public probe failed after local readiness; using best-effort URL`,
        {
          fallbackUrl,
          error: message,
          timeoutMs,
        },
      );
      return fallbackUrl;
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private shellQuote(value: string): string {
    return `'${value.replace(/'/g, "'\\''")}'`;
  }

  private async runBashChecked(
    vm: Vm,
    command: string,
    label: string,
    options?: { timeoutMs?: number },
  ) {
    const commandWithEnv = `export PATH="$HOME/.deno/bin:$PATH" && ${command}`;
    const timeoutMs = options?.timeoutMs ?? this.execTimeoutMs;
    const execPromise = vm.exec({
      command: `bash -lc ${this.shellQuote(commandWithEnv)}`,
      timeoutMs,
    });
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        timedOut = true;
        reject(
          new Error(
            `${label} timed out after ${timeoutMs}ms waiting for vm.exec response.`,
          ),
        );
      }, timeoutMs + EXEC_TIMEOUT_GRACE_MS);
    });

    let result: any;
    try {
      result = await Promise.race([execPromise, timeoutPromise]);
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
      if (timedOut) {
        execPromise.catch(() => {
          // Ignore eventual completion/rejection after timeout escape.
        });
      }
    }
    const exitCode = Number(result?.statusCode ?? 0);
    if (exitCode !== 0) {
      const stdout = clipText(result?.stdout, 2000, "both");
      const stderr = clipText(result?.stderr, 4000, "both");
      throw new Error(
        `${label} failed (exit=${exitCode}). stdout=${
          stdout || "<empty>"
        } stderr=${stderr || "<empty>"}`,
      );
    }
    return result;
  }

  private async readRemoteLog(vm: Vm, logPath: string): Promise<string> {
    try {
      const result = await vm.exec({
        command: `bash -lc ${
          this.shellQuote(
            `if [ -f ${logPath} ]; then tail -n 120 ${logPath}; else echo "<missing ${logPath}>"; fi`,
          )
        }`,
      });
      return clipText(result?.stdout || result?.stderr || "", 4000, "end");
    } catch {
      return `<failed to read ${logPath}>`;
    }
  }

  private async readSystemdLog(
    vm: Vm,
    serviceId?: string | null,
  ): Promise<string> {
    if (!serviceId) return "<no service id>";
    try {
      const result = await vm.systemd.getLogs({
        serviceId,
        lines: 120,
      } as any);
      const logs = Array.isArray((result as any)?.logs)
        ? (result as any).logs.map((entry: any) =>
          String(entry?.message || "").trim()
        ).filter((line: string) => line.length > 0).join("\n")
        : "";
      return clipText(logs || "<empty systemd logs>", 4000, "end");
    } catch (error) {
      return `<failed to read systemd logs for ${serviceId}: ${
        error instanceof Error ? error.message : String(error)
      }>`;
    }
  }

  private detectFatalStartupIssue(logSnippet: string): string | null {
    if (!logSnippet || logSnippet.startsWith("<missing")) return null;
    for (const pattern of FATAL_BACKEND_LOG_PATTERNS) {
      const match = logSnippet.match(pattern);
      if (match && match[0]) return match[0].trim();
    }
    return null;
  }

  private getMongoHostname(mongoUrl: string): string | null {
    try {
      return new URL(mongoUrl).hostname || null;
    } catch {
      return null;
    }
  }

  private buildMongoDiagnosticsCommand(mongoUrl: string): string | null {
    const hostname = this.getMongoHostname(mongoUrl);
    if (!hostname) return null;
    const hostQuoted = this.shellQuote(hostname);
    const srvHostQuoted = this.shellQuote(`_mongodb._tcp.${hostname}`);
    return `
set +e
echo "mongo_host=${hostname}"
echo "--- resolv.conf ---"
cat /etc/resolv.conf 2>/dev/null || true
echo "--- hosts lookup ---"
if command -v getent >/dev/null 2>&1; then
  getent ahosts ${hostQuoted} || true
else
  echo "getent unavailable"
fi
echo "--- node dns/tcp diagnostics ---"
if command -v node >/dev/null 2>&1; then
  MONGO_HOST=${hostQuoted} MONGO_SRV_HOST=${srvHostQuoted} node <<'NODE'
const dns = require('node:dns').promises;
const net = require('node:net');
const tls = require('node:tls');

const host = process.env.MONGO_HOST || '';
const srvHost = process.env.MONGO_SRV_HOST || '';

async function checkTcp(targetHost, port) {
  await new Promise((resolve) => {
    const socket = net.connect({ host: targetHost, port, timeout: 3000 }, () => {
      console.log('tcp ok ' + targetHost + ':' + port);
      socket.destroy();
      resolve();
    });
    socket.on('timeout', () => {
      console.log('tcp timeout ' + targetHost + ':' + port);
      socket.destroy();
      resolve();
    });
    socket.on('error', (error) => {
      console.log('tcp error ' + targetHost + ':' + port + ': ' + error.message);
      resolve();
    });
  });
}

async function checkTls(targetHost, port) {
  await new Promise((resolve) => {
    const socket = tls.connect({
      host: targetHost,
      port,
      servername: targetHost,
      rejectUnauthorized: true,
      timeout: 5000,
    }, () => {
      console.log(
        'tls ok ' + targetHost + ':' + port +
          ' authorized=' + String(socket.authorized) +
          ' authorizationError=' + String(socket.authorizationError || 'none'),
      );
      socket.end();
      resolve();
    });
    socket.on('timeout', () => {
      console.log('tls timeout ' + targetHost + ':' + port);
      socket.destroy();
      resolve();
    });
    socket.on('error', (error) => {
      console.log('tls error ' + targetHost + ':' + port + ': ' + error.message);
      resolve();
    });
  });
}

(async () => {
  try {
    const records = await dns.resolveSrv(srvHost);
    console.log('srv ' + JSON.stringify(records));
    for (const record of records.slice(0, 3)) {
      try {
        const addresses = await dns.lookup(record.name, { all: true });
        console.log('lookup ' + record.name + ' ' + JSON.stringify(addresses));
      } catch (error) {
        console.log('lookup failed ' + record.name + ': ' + error.message);
      }
      await checkTcp(record.name, record.port);
      await checkTls(record.name, record.port);
    }
  } catch (error) {
    console.log('resolveSrv failed: ' + error.message);
  }

  try {
    const txt = await dns.resolveTxt(host);
    console.log('txt ' + JSON.stringify(txt));
  } catch (error) {
    console.log('resolveTxt failed: ' + error.message);
  }

  try {
    const direct = await dns.lookup(host, { all: true });
    console.log('direct lookup ' + host + ' ' + JSON.stringify(direct));
  } catch (error) {
    console.log('direct lookup failed ' + host + ': ' + error.message);
  }
})();
NODE
else
  echo "node unavailable"
fi
`;
  }

  private async readMongoDiagnostics(
    vm: Vm,
    mongoUrl: string,
  ): Promise<string> {
    const command = this.buildMongoDiagnosticsCommand(mongoUrl);
    if (!command) return "<mongo diagnostics unavailable: invalid mongo url>";
    try {
      const result = await vm.exec({
        command: `bash -lc ${this.shellQuote(command)}`,
        timeoutMs: 20_000,
      });
      return clipText(
        [result?.stdout || "", result?.stderr || ""].filter(Boolean).join("\n"),
        2400,
      ) || "<empty mongo diagnostics>";
    } catch (diagnosticError) {
      return `<failed to run mongo diagnostics: ${
        diagnosticError instanceof Error
          ? diagnosticError.message
          : String(diagnosticError)
      }>`;
    }
  }
}
