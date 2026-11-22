/** The address this sidecar is reachable at on its own machine, once it listens (`http://host:port`). */
let url: string | undefined;

export function setSidecarUrl(host: string, port: number): string {
  const reachable = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  url = `http://${reachable.includes(":") ? `[${reachable}]` : reachable}:${port}`;
  return url;
}

export function sidecarUrl(): string | undefined {
  return url;
}
