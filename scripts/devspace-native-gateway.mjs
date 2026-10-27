import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createNativeMcpDiagnosticSink } from './lib/native-mcp-diagnostics.mjs';

/** Keep DevSpace's OAuth store and resource identity; forward structured MCP, never shell text. */
export async function createDevSpaceNativeGateway(options) {
  const moduleDirectory = resolve(options.moduleDirectory);
  const requireDevSpace = createRequire(join(moduleDirectory, 'package.json'));
  const packageInfo = JSON.parse(readFileSync(join(moduleDirectory, 'package.json'), 'utf8'));
  if (packageInfo.version !== '1.0.8') throw new Error('Native gateway requires the verified DevSpace 1.0.8 auth adapter.');
  const importDevSpace = name => import(pathToFileURL(join(moduleDirectory, 'dist', name)).href);
  const importSdk = name => import(pathToFileURL(requireDevSpace.resolve(`@modelcontextprotocol/sdk/${name}`)).href);
  const [{ loadConfig }, { SingleUserOAuthProvider }, { McpSessionRegistry },
    { createMcpExpressApp }, { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl },
    { requireBearerAuth }, { StreamableHTTPServerTransport }, { StdioClientTransport },
    { isInitializeRequest }, { checkResourceAllowed, resourceUrlFromServerUrl }] = await Promise.all([
    importDevSpace('config.js'), importDevSpace('oauth-provider.js'), importDevSpace('mcp-sessions.js'),
    importSdk('server/express.js'), importSdk('server/auth/router.js'), importSdk('server/auth/middleware/bearerAuth.js'),
    importSdk('server/streamableHttp.js'), importSdk('client/stdio.js'), importSdk('types.js'), importSdk('shared/auth-utils.js'),
  ]);
  const config = loadConfig();
  const resource = resourceUrlFromServerUrl(new URL('/mcp', config.publicBaseUrl));
  const provider = new SingleUserOAuthProvider(config.oauth, new URL('/mcp', config.publicBaseUrl), config.stateDir);
  const auth = requireBearerAuth({ verifier: provider, requiredScopes: [config.oauth.scopes[0] ?? 'devspace'],
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resource) });
  const app = createMcpExpressApp({ host: config.host,
    ...(config.allowedHosts.includes('*') ? {} : { allowedHosts: [...new Set([config.host, ...config.allowedHosts])] }) });
  const sessions = new McpSessionRegistry();
  const pairs = new Set();
  app.use(mcpAuthRouter({ provider, issuerUrl: new URL(config.publicBaseUrl), baseUrl: new URL(config.publicBaseUrl),
    resourceServerUrl: resource, scopesSupported: config.oauth.scopes, resourceName: 'DevSpace native gateway' }));
  app.get('/healthz', (_req, res) => res.json({ ok: true, name: 'devspace', mode: 'native', sessions: sessions.size,
    activeRequests: [...pairs].reduce((total, pair) => total + pair.pending.size, 0) }));
  app.all('/mcp', auth, async (req, res) => {
    if (!req.auth?.resource || !checkResourceAllowed({ requestedResource: req.auth.resource, configuredResource: resource })) {
      res.status(401).json({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized resource' } });
      return;
    }
    let allocatedPair;
    try {
      const sessionId = req.header('mcp-session-id');
      let transport = sessionId ? sessions.get(sessionId) : undefined;
      if (sessionId && !transport) {
        res.status(404).json({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Unknown MCP session' } });
        return;
      }
      if (!transport) {
        if (req.method !== 'POST' || !isInitializeRequest(req.body)) {
          res.status(400).json({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Initialize an MCP session first' } });
          return;
        }
        if (pairs.size >= 16) { res.status(503).end(); return; }
        const stdio = new StdioClientTransport({ command: options.bunPath,
          args: ['run', options.cliPath, '--home', options.bridgeHome, 'mcp'],
          cwd: options.projectRoot, stderr: 'pipe' });
        const http = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID,
          onsessioninitialized: id => sessions.register(id, http) });
        const pair = { http, stdio, cleanup: undefined, pending: new Map() };
        allocatedPair = pair;
        pairs.add(pair);
        const closePair = () => {
          if (pair.cleanup) return pair.cleanup;
          pair.cleanup = Promise.resolve().then(async () => {
            if (http.sessionId) sessions.remove(http.sessionId);
            await Promise.allSettled([http.close(), stdio.close()]);
            pairs.delete(pair);
          });
          return pair.cleanup;
        };
        pair.close = closePair;
        const failed = () => { console.error('Native MCP session transport failed.'); void closePair(); };
        http.onmessage = message => {
          if (message.method === 'notifications/cancelled') pair.pending.delete(message.params?.requestId);
          if ('method' in message && 'id' in message) pair.pending.set(message.id, message.params?._meta?.progressToken);
          void stdio.send(message).catch(failed);
        };
        stdio.onmessage = message => {
          if (http.sessionId) sessions.get(http.sessionId);
          let relatedRequestId;
          if ('method' in message) {
            if (message.method === 'notifications/progress') {
              relatedRequestId = [...pair.pending].find(([, token]) => token !== undefined && token === message.params?.progressToken)?.[0];
            }
            if (relatedRequestId === undefined && pair.pending.size === 1) relatedRequestId = pair.pending.keys().next().value;
            if ('id' in message && relatedRequestId === undefined && pair.pending.size > 1) {
              // JSON-RPC does not carry the originating client request here. Fail explicitly
              // instead of dropping a server request or sending it to an unrelated call.
              void stdio.send({ jsonrpc: '2.0', id: message.id, error: { code: -32000,
                message: 'Native gateway cannot correlate a concurrent server request.' } }).catch(failed);
              return;
            }
          } else if ('id' in message) pair.pending.delete(message.id);
          void http.send(message, relatedRequestId === undefined ? undefined : { relatedRequestId })
            .catch(() => { console.error('Native MCP response consumer disconnected.'); });
        };
        http.onerror = () => { console.error('Native MCP HTTP request rejected.'); };
        stdio.onerror = failed;
        http.onclose = () => { void closePair(); };
        stdio.onclose = () => { void closePair(); };
        stdio.stderr?.on('data', createNativeMcpDiagnosticSink(event =>
          console.error(`[native-mcp] ${JSON.stringify(event)}`)));
        try { await stdio.start(); await http.start(); } catch (error) { await closePair(); throw error; }
        transport = http;
      }
      await transport.handleRequest(req, res, req.body);
    } catch {
      console.error('Native MCP HTTP request failed.');
      if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'Native gateway unavailable' } });
    } finally {
      if (allocatedPair && !allocatedPair.http.sessionId) await allocatedPair.close();
    }
  });
  const cleanup = setInterval(() => {
    for (const pair of pairs) {
      if (pair.pending.size && pair.http.sessionId) sessions.get(pair.http.sessionId);
    }
    void sessions.closeIdle(90_000);
  }, 15_000);
  cleanup.unref();
  return { app, config, async close() {
    clearInterval(cleanup);
    const closing = [...pairs].map(pair => pair.close());
    await sessions.closeAll();
    await Promise.allSettled(closing);
  } };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const moduleDirectory = process.env.DEVSPACE_MODULE_DIR;
  const bunPath = process.env.CODEX_WEB_GPT_BUN;
  const bridgeHome = process.env.CODEX_CHATGPT_WEB_HOME;
  if (!moduleDirectory || !bunPath || !bridgeHome) throw new Error('Native gateway requires explicit DevSpace, Bun and bridge profile paths.');
  const gateway = await createDevSpaceNativeGateway({ moduleDirectory, bunPath, bridgeHome,
    cliPath: join(projectRoot, 'src', 'cli.ts'), projectRoot });
  const listener = gateway.app.listen(gateway.config.port, gateway.config.host,
    () => console.log(`DevSpace native MCP gateway listening on ${gateway.config.host}:${gateway.config.port}`));
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    listener.close();
    await gateway.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
