import * as net from "node:net";

export interface RequestedListenOptions {
  readonly host: string;
  readonly port: number;
  readonly portExplicit: boolean;
}

export interface ResolvedListenOptions extends RequestedListenOptions {
  readonly message: string | null;
  readonly publicUrl: string | null;
}

const PORTLESS_DYNAMIC_PORT_MIN = 4_000;
const PORTLESS_DYNAMIC_PORT_MAX = 4_999;
const RANDOM_PORT_ATTEMPTS = 50;

const normalizeString = (value: string | undefined): string | null => {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? null : trimmed;
};

const parsePort = (value: string | undefined): number | null => {
  const trimmed = normalizeString(value);
  if (trimmed === null) {
    return null;
  }

  const port = Number(trimmed);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    return null;
  }

  return port;
};

const canListen = async (host: string, port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const server = net.createServer();
    let settled = false;

    const finish = (result: boolean) => {
      if (settled) {
        return;
      }

      settled = true;
      resolve(result);
    };

    server.once("error", () => {
      finish(false);
    });

    server.listen({ host, port }, () => {
      server.close(() => finish(true));
    });
  });

// Adapted from vercel-labs/portless `findFreePort` in `packages/portless/src/cli-utils.ts`.
export const findPortlessCompatiblePort = async (
  minPort = PORTLESS_DYNAMIC_PORT_MIN,
  maxPort = PORTLESS_DYNAMIC_PORT_MAX,
  host = "127.0.0.1"
): Promise<number> => {
  if (minPort > maxPort) {
    throw new Error(`minPort (${minPort}) must be <= maxPort (${maxPort})`);
  }

  for (let index = 0; index < RANDOM_PORT_ATTEMPTS; index += 1) {
    const candidate =
      minPort + Math.floor(Math.random() * (maxPort - minPort + 1));
    if (await canListen(host, candidate)) {
      return candidate;
    }
  }

  for (let candidate = minPort; candidate <= maxPort; candidate += 1) {
    if (await canListen(host, candidate)) {
      return candidate;
    }
  }

  throw new Error(`No free port found in ${minPort}-${maxPort}.`);
};

export const resolveListenOptions = async (
  requested: RequestedListenOptions,
  env: NodeJS.ProcessEnv = process.env
): Promise<ResolvedListenOptions> => {
  const publicUrl = normalizeString(env.PORTLESS_URL);
  const portlessAssignedPort =
    parsePort(env.PORTLESS_APP_PORT) ?? (publicUrl === null ? null : parsePort(env.PORT));
  const portlessHost = normalizeString(env.HOST);

  if (!requested.portExplicit && portlessAssignedPort !== null) {
    return {
      host: portlessHost ?? requested.host,
      message:
        publicUrl === null
          ? `Using portless-assigned port ${portlessAssignedPort}.`
          : `Using portless-assigned port ${portlessAssignedPort} (${publicUrl}).`,
      port: portlessAssignedPort,
      portExplicit: false,
      publicUrl,
    };
  }

  if (requested.portExplicit || (await canListen(requested.host, requested.port))) {
    return {
      ...requested,
      message: null,
      publicUrl,
    };
  }

  const fallbackPort = await findPortlessCompatiblePort(
    PORTLESS_DYNAMIC_PORT_MIN,
    PORTLESS_DYNAMIC_PORT_MAX,
    requested.host
  );

  return {
    host: requested.host,
    message: `Port ${requested.port} is in use, using ${fallbackPort} instead.`,
    port: fallbackPort,
    portExplicit: false,
    publicUrl,
  };
};
