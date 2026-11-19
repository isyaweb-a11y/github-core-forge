// Entry point and process bootstrap for the forge.
//
// The graded surface is the HTTP server that app.ts builds; this file owns everything around it:
// configuration, startup, the registration handshake with the trial environment, and shutdown.
//
// The environment contract (settled by the kit's env, and not negotiable):
//
//   * MAKEFUN_ENV_URL names the env's origin. With no env there is nothing to register with,
//     so a missing or malformed value is a configuration error and the process exits 1 at once.
//   * The server binds an ephemeral port with listen(0). The env owns the fixed ports; the entry
//     must never claim one. The bound port is announced with POST {env}/register {"port": N};
//     the env records the caller's address plus N and dials that base URL from then on.
//   * Registering is retried with exponential backoff until the env accepts: 200 means the port
//     is recorded, 409 means another process registered first (equally final — the first
//     register wins), and 400/405 are contract errors that end the program. Anything else
//     (a refusal, a timeout, a 5xx) is retried, because the env may still be starting.
//   * The process then polls GET {env}/done until the body is {"done": true}. The env answers
//     immediately either way, so this is a poll on the same backoff, never a held request, and
//     the process never exits before the env says the trial is over.
//   * Only then does the server close — draining live connections briefly rather than cutting
//     them — and the process exits 0.
//
// Signals are the one other way out: SIGINT/SIGTERM stop the wait, drain the server the same
// way, and exit 0, so a supervisor stopping the entry mid-trial still gets a clean close.
//
// Like the starter, this file imports only its own server: every other facility it uses is a
// Node global (fetch, AbortSignal, timers, process).

import { createApp } from './app.ts';

type Server = ReturnType<typeof createApp>;

/** Tunables for the lifecycle, resolved once from the environment at startup. */
interface EntryConfig {
  /** The env's origin, with no trailing slash. */
  readonly envUrl: string;
  /** How long one register or done request may run before it is abandoned and retried. */
  readonly requestTimeoutMs: number;
  /** The first wait between retries; each subsequent wait doubles from it. */
  readonly retryInitialMs: number;
  /** The longest wait between retries. */
  readonly retryMaxMs: number;
  /** How long shutdown waits for live connections to finish before forcing them closed. */
  readonly drainTimeoutMs: number;
  /** True when FORGE_ENTRY_LOG_LEVEL=debug: lifecycle diagnostics also go to stderr. */
  readonly debug: boolean;
}

/** Raised when the env rejects registration as a contract error (HTTP 400 or 405). */
class RegisterContractError extends Error {
  readonly status: number;

  constructor(status: number, body: string) {
    super(`the env answered register with HTTP ${status}: ${body}`);
    this.status = status;
  }
}

/** Raised in the wait loops when a signal has asked the process to shut down. */
class ShutdownRequested extends Error {
  constructor() {
    super('shutdown requested by signal');
  }
}

/** An integer environment override, or the fallback when it is absent or not a positive integer. */
function intFromEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * Resolve the entry's configuration from the environment. A missing or malformed MAKEFUN_ENV_URL
 * is the only fatal case, and it is reported by throwing, so the caller can print and exit 1
 * before any server exists.
 */
function loadConfig(env: NodeJS.ProcessEnv): EntryConfig {
  const envUrl = (env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
  if (envUrl === '') {
    throw new Error('MAKEFUN_ENV_URL is not set: there is no env to register with');
  }
  let parsed: URL;
  try {
    parsed = new URL(envUrl);
  } catch {
    throw new Error(`MAKEFUN_ENV_URL is not a valid URL: ${JSON.stringify(envUrl)}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`MAKEFUN_ENV_URL must be an http(s) origin, got ${JSON.stringify(parsed.protocol)}`);
  }
  return {
    envUrl,
    requestTimeoutMs: intFromEnv(env, 'FORGE_ENTRY_REQUEST_TIMEOUT_MS', 30_000),
    retryInitialMs: intFromEnv(env, 'FORGE_ENTRY_RETRY_INITIAL_MS', 250),
    retryMaxMs: intFromEnv(env, 'FORGE_ENTRY_RETRY_MAX_MS', 2_000),
    drainTimeoutMs: intFromEnv(env, 'FORGE_ENTRY_DRAIN_TIMEOUT_MS', 3_000),
    debug: (env.FORGE_ENTRY_LOG_LEVEL ?? '').toLowerCase() === 'debug',
  };
}

/** Lifecycle output: progress lines on stdout, diagnostics and errors on stderr. */
class EntryLog {
  private readonly debugEnabled: boolean;

  constructor(debugEnabled: boolean) {
    this.debugEnabled = debugEnabled;
  }

  /** A lifecycle milestone (the lines the harness's log shows for a healthy run). */
  info(line: string): void {
    process.stdout.write(`[entry] ${line}\n`);
  }

  /** A diagnostic line, only when debug logging is on. */
  debug(line: string): void {
    if (this.debugEnabled) {
      process.stderr.write(`[entry] ${new Date().toISOString()} ${line}\n`);
    }
  }

  /** A failure line; always shown. */
  error(line: string): void {
    process.stderr.write(`[entry] ${line}\n`);
  }
}

/** The wait after `attempt` failed tries: exponential from the configured start, capped. */
function backoffMs(config: EntryConfig, attempt: number): number {
  return Math.min(config.retryMaxMs, config.retryInitialMs * 2 ** Math.min(attempt, 8));
}

/**
 * Sleep for `ms`, waking early if the lifecycle is aborted. Callers re-check the abort state
 * after sleeping, so an early wake needs no error of its own.
 */
function sleep(ms: number, lifecycle: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (lifecycle.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      lifecycle.removeEventListener('abort', wake);
      resolve();
    }, ms);
    const wake = (): void => {
      clearTimeout(timer);
      resolve();
    };
    lifecycle.addEventListener('abort', wake, { once: true });
  });
}

/** Throw ShutdownRequested when a signal has asked the process to stop. */
function throwIfShutdown(lifecycle: AbortSignal): void {
  if (lifecycle.aborted) throw new ShutdownRequested();
}

/**
 * Announce the bound port to the env, retrying until it is recorded. Returns on 200 (recorded)
 * and on 409 (another process registered first, which the env treats as final); throws
 * RegisterContractError on 400/405; retries every other outcome after a backoff.
 */
async function registerWithEnv(config: EntryConfig, log: EntryLog, port: number, lifecycle: AbortSignal): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    throwIfShutdown(lifecycle);
    try {
      const res = await fetch(`${config.envUrl}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.any([AbortSignal.timeout(config.requestTimeoutMs), lifecycle]),
      });
      if (res.status === 200 || res.status === 409) {
        log.debug(`register answered HTTP ${res.status} on attempt ${attempt + 1}`);
        return;
      }
      if (res.status === 400 || res.status === 405) {
        throw new RegisterContractError(res.status, await res.text());
      }
      log.debug(`register answered HTTP ${res.status} on attempt ${attempt + 1}; retrying`);
    } catch (err) {
      if (err instanceof RegisterContractError) throw err;
      throwIfShutdown(lifecycle);
      log.debug(`register attempt ${attempt + 1} failed (${err instanceof Error ? err.message : String(err)}); retrying`);
    }
    await sleep(backoffMs(config, attempt), lifecycle);
  }
}

/** Poll the env's /done until it answers {"done": true}; never return before that. */
async function waitForEnvDone(config: EntryConfig, log: EntryLog, lifecycle: AbortSignal): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    throwIfShutdown(lifecycle);
    try {
      const res = await fetch(`${config.envUrl}/done`, {
        signal: AbortSignal.any([AbortSignal.timeout(config.requestTimeoutMs), lifecycle]),
      });
      if (res.ok) {
        const body = (await res.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch (err) {
      throwIfShutdown(lifecycle);
      // The env is not answering yet, or the poll timed out: it is not done, so poll again.
      log.debug(`done poll ${attempt + 1} failed (${err instanceof Error ? err.message : String(err)}); polling again`);
    }
    await sleep(backoffMs(config, attempt), lifecycle);
  }
}

/**
 * Close the server, giving live connections up to the drain timeout to finish on their own
 * before the rest are forced closed. Resolves once the server is fully closed.
 */
function closeServer(server: Server, config: EntryConfig): Promise<void> {
  return new Promise((resolve) => {
    const force = setTimeout(() => {
      server.closeAllConnections();
    }, config.drainTimeoutMs);
    force.unref();
    server.close(() => {
      clearTimeout(force);
      resolve();
    });
    server.closeIdleConnections();
  });
}

/**
 * Run the entry's whole life: bind, register, wait, drain. Resolves with the exit code the
 * process should use: 0 for a completed trial or a signal-requested shutdown, 1 for a failure.
 */
async function run(config: EntryConfig, log: EntryLog): Promise<number> {
  const lifecycle = new AbortController();
  let server: Server | undefined;
  let shuttingDown = false;

  const onSignal = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.error(`received ${signal}; shutting down`);
    lifecycle.abort();
    // If the server is already up, drain it here; run() observes the abort and finishes the
    // exit itself. The timer is a backstop so a stuck drain can never hang the process.
    if (server !== undefined) {
      const backstop = setTimeout(() => process.exit(0), config.drainTimeoutMs + 1_000);
      backstop.unref();
      void closeServer(server, config).then(() => process.exit(0));
    }
  };
  process.on('SIGINT', () => onSignal('SIGINT'));
  process.on('SIGTERM', () => onSignal('SIGTERM'));

  try {
    server = createApp();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, () => resolve());
    });
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('the server did not bind an ephemeral TCP port');
    }
    log.info(`listening on port ${address.port}`);

    await registerWithEnv(config, log, address.port, lifecycle.signal);
    log.info('registered with the env; waiting for it to say done');

    await waitForEnvDone(config, log, lifecycle.signal);
    log.debug('the env says the trial is done');
  } catch (err) {
    // A stop the lifecycle asked for (ShutdownRequested, or any error surfacing after the
    // abort) falls through to the drain below; every other failure is fatal and propagates.
    if (!(err instanceof ShutdownRequested) && !lifecycle.aborted) throw err;
  }

  if (server !== undefined) {
    await closeServer(server, config);
  }
  log.info('done');
  return 0;
}

// Top level: configuration first (a bad env is a clean exit 1 before anything is built), then
// the lifecycle. Anything that escapes run() is a fatal startup failure: report and exit 1.
let log = new EntryLog(false);
try {
  const config = loadConfig(process.env);
  log = new EntryLog(config.debug);
  log.debug(
    `config: env=${config.envUrl} requestTimeoutMs=${config.requestTimeoutMs} ` +
      `retry=${config.retryInitialMs}..${config.retryMaxMs}ms drainTimeoutMs=${config.drainTimeoutMs}`,
  );
  process.exit(await run(config, log));
} catch (err) {
  log.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
