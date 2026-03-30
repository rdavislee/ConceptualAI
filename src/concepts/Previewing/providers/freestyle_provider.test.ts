import { assertEquals, assertRejects } from "jsr:@std/assert";
import { FreestylePreviewProvider } from "./freestyle_provider.ts";

Deno.test("FreestylePreviewProvider builds same-origin frontend gateway script", () => {
  const provider = new FreestylePreviewProvider() as any;

  const script = provider.buildFrontendGatewayScript(
    "preview-host.vm.freestyle.sh",
  );

  assertEquals(
    script.includes('const FRONTEND_TARGET = "http://127.0.0.1:5173";'),
    true,
  );
  assertEquals(
    script.includes('const BACKEND_TARGET = "http://127.0.0.1:8000";'),
    true,
  );
  assertEquals(
    script.includes(
      'source.pathname.startsWith("/api") ? BACKEND_TARGET : FRONTEND_TARGET',
    ),
    true,
  );
  assertEquals(
    script.includes('requestHost !== "preview-host.vm.freestyle.sh"'),
    true,
  );
  assertEquals(
    script.includes(
      'source.pathname === "/api" || source.pathname === "/api/"',
    ),
    true,
  );
  assertEquals(
    script.includes('message: "Preview backend gateway is running."'),
    true,
  );
});

Deno.test("FreestylePreviewProvider serves the built frontend with vite preview", () => {
  const provider = new FreestylePreviewProvider() as any;

  assertEquals(
    provider.getFrontendServeCommand(),
    "npx vite preview --host 0.0.0.0 --port 5173 --strictPort",
  );
});

Deno.test("FreestylePreviewProvider wraps systemd commands in bash with explicit PATH", () => {
  const provider = new FreestylePreviewProvider() as any;

  const execCommand = provider.buildSystemdExecCommand("deno task start");

  assertEquals(execCommand[0], "/bin/bash");
  assertEquals(execCommand[1], "-lc");
  assertEquals(
    execCommand[2].includes("export PATH="),
    true,
  );
  assertEquals(
    execCommand[2].includes("exec deno task start"),
    true,
  );
});

Deno.test("FreestylePreviewProvider defaults backend runtime to Mozilla and system CA stores", () => {
  const provider = new FreestylePreviewProvider() as any;

  const backendEnv = provider.buildBackendRuntimeEnv({
    MONGODB_URL: "mongodb://example",
  });

  assertEquals(backendEnv.DENO_TLS_CA_STORE, "mozilla,system");
  assertEquals(backendEnv.MONGODB_URL, "mongodb://example");
});

Deno.test("FreestylePreviewProvider expands mongodb+srv URLs for backend runtime", async () => {
  const provider = new FreestylePreviewProvider() as any;

  provider.resolveMongoSrvRecords = async () => [
    { name: "shard-01.mongodb.net", port: 27017 },
    { name: "shard-00.mongodb.net", port: 27017 },
  ];
  provider.resolveMongoTxtParams = async () => [
    ["authSource", "admin"],
    ["replicaSet", "atlas-abc-shard-0"],
  ];

  const result = await provider.expandMongoSrvUrl(
    "mongodb+srv://user:pass@cluster0.example.mongodb.net/mydb?appName=Cluster0",
  );

  assertEquals(
    result,
    "mongodb://user:pass@shard-01.mongodb.net:27017,shard-00.mongodb.net:27017/mydb?appName=Cluster0&authSource=admin&replicaSet=atlas-abc-shard-0&tls=true&connectTimeoutMS=5000",
  );
});

Deno.test("FreestylePreviewProvider prefers freestyle.sh hostname for frontend allowlist", () => {
  const provider = new FreestylePreviewProvider() as any;

  const result = provider.selectPreferredDomain([
    "preview-host.vm.freestyle.it.com",
    "preview-host.vm.freestyle.sh",
  ]);

  assertEquals(result, "preview-host.vm.freestyle.sh");
});

Deno.test("FreestylePreviewProvider falls back to first hostname when freestyle.sh is unavailable", () => {
  const provider = new FreestylePreviewProvider() as any;

  const result = provider.selectPreferredDomain([
    "preview-host.vm.freestyle.it.com",
  ]);

  assertEquals(result, "preview-host.vm.freestyle.it.com");
});

Deno.test("FreestylePreviewProvider falls back to inferred backend URL after probe failure", async () => {
  const provider = new FreestylePreviewProvider() as any;
  let seenTimeoutMs: number | null = null;
  provider.waitForPublicUrl = async () => {
    seenTimeoutMs = 60_000;
    throw new Error("probe failed");
  };

  const result = await provider.resolvePublicUrlWithFallback({
    domains: ["preview-host.vm.freestyle.sh"],
    externalPort: 8081,
    probePath: "/",
    label: "backend",
    allowBestEffortFallback: true,
    timeoutMs: 60_000,
  });

  assertEquals(result, "https://preview-host.vm.freestyle.sh:8081");
  assertEquals(seenTimeoutMs, 60_000);
});

Deno.test("FreestylePreviewProvider rethrows probe failure when fallback is disabled", async () => {
  const provider = new FreestylePreviewProvider() as any;
  provider.waitForPublicUrl = async () => {
    throw new Error("probe failed");
  };

  await assertRejects(
    () =>
      provider.resolvePublicUrlWithFallback({
        domains: ["preview-host.vm.freestyle.sh"],
        externalPort: 443,
        probePath: "/",
        label: "frontend",
        allowBestEffortFallback: false,
        timeoutMs: 120_000,
      }),
    Error,
    "probe failed",
  );
});

Deno.test("FreestylePreviewProvider uses a one-minute backend public probe timeout by default", () => {
  const provider = new FreestylePreviewProvider() as any;

  assertEquals(provider.backendProbeTimeoutMs, 60_000);
  assertEquals(provider.probeTimeoutMs, 120_000);
});

Deno.test("FreestylePreviewProvider builds Mongo diagnostics for Atlas host", () => {
  const provider = new FreestylePreviewProvider() as any;

  const command = provider.buildMongoDiagnosticsCommand(
    "mongodb+srv://user:pass@cluster0.example.mongodb.net/?appName=Cluster0",
  );

  assertEquals(
    command?.includes("mongo_host=cluster0.example.mongodb.net"),
    true,
  );
  assertEquals(
    command?.includes(
      "MONGO_SRV_HOST='_mongodb._tcp.cluster0.example.mongodb.net' node <<'NODE'",
    ),
    true,
  );
  assertEquals(
    command?.includes("const records = await dns.resolveSrv(srvHost);"),
    true,
  );
  assertEquals(
    command?.includes("await checkTcp(record.name, record.port);"),
    true,
  );
  assertEquals(
    command?.includes("await checkTls(record.name, record.port);"),
    true,
  );
});
