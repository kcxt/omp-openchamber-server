import { parseArgs } from "node:util";
import { validateOmpBinary } from "../../providers/omp/binary";

export interface SidecarCliOptions {
  binary?: string;
  port?: number;
  host?: string;
  help?: boolean;
}

/**
 * Parse CLI options for the OMP sidecar.
 * Supports:
 *   -b, --binary <path>      Path to custom OMP binary (aliases: --omp-bin, --omp-binary)
 *   -p, --port <port>        Port to listen on
 *       --host <host>        Address to bind (default 127.0.0.1)
 *   -h, --help               Show help message
 */
export function parseCliArgs(argv: string[] = process.argv.slice(2)): SidecarCliOptions {
  // Strip leading "--" if invoked via `bun run start -- ...` or `npm start -- ...`
  const args = argv[0] === "--" ? argv.slice(1) : argv;

  const { values } = parseArgs({
    args,
    options: {
      binary: { type: "string", short: "b" },
      "omp-bin": { type: "string" },
      "omp-binary": { type: "string" },
      port: { type: "string", short: "p" },
      host: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    strict: false,
    allowPositionals: true,
  });

  const rawBinary = values.binary || values["omp-binary"] || values["omp-bin"];
  let binary: string | undefined;
  if (typeof rawBinary === "string" && rawBinary.trim()) {
    binary = validateOmpBinary(rawBinary.trim());
  }

  let port: number | undefined;
  if (typeof values.port === "string" && values.port.trim()) {
    const parsedPort = Number(values.port.trim());
    if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
      throw new Error(`Invalid port: ${values.port}. Port must be an integer between 1 and 65535.`);
    }
    port = parsedPort;
  }

  let host: string | undefined;
  if (typeof values.host === "string" && values.host.trim()) {
    host = values.host.trim();
    if (/\s/.test(host) || host.startsWith("http")) {
      throw new Error(`Invalid host: ${values.host}. Use a bare address such as 185.176.36.123 or myhost.mytailnet.example.`);
    }
  }

  return {
    binary,
    port,
    host,
    help: Boolean(values.help),
  };
}

export function printHelp(): void {
  console.log(`OpenChamber OMP Sidecar

Usage:
  bun run src/main.ts [options]
  bun run start -- [options]

Options:
  -b, --binary <path>     Path to custom OMP binary (aliases: --omp-bin, --omp-binary)
  -p, --port <port>       Port to listen on (default: 4096, or OC_SIDECAR_PORT)
      --host <host>       Address to bind (default: 127.0.0.1, or OC_SIDECAR_HOST)
  -h, --help              Show this help message

Environment Variables:
  OMP_BIN                   Path to custom OMP binary
  OC_SIDECAR_PORT           Port to listen on
  OC_SIDECAR_HOST           Address to bind; bind to the Tailscale network address
                            (tailscale ip -4) to reach the sidecar from other
                            devices on the tailnet without a tunnel
  LOG_LEVEL                   pino level (default: info; debug enables the per-request
                            access log)
`);
}
