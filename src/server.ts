import { createServer } from "node:http";
import { loadConfig } from "./config.js";
import { VersionExporter } from "./exporter.js";

const configPath = process.env.CONFIG_FILE ?? "./config.json";
const port = Number(process.env.PORT ?? "9090");
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error("PORT must be an integer between 1 and 65535");
}

const config = await loadConfig(configPath);
const exporter = new VersionExporter(config);
const server = createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/healthz") {
    response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    response.end("ok\n");
    return;
  }

  if (request.method === "GET" && request.url === "/metrics") {
    try {
      const metrics = await exporter.metrics.registry.metrics();
      response.writeHead(200, { "content-type": exporter.metrics.registry.contentType });
      response.end(metrics);
    } catch (error) {
      console.error("Failed to render Prometheus metrics:", error);
      response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      response.end("metrics unavailable\n");
    }
    return;
  }

  response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  response.end("not found\n");
});

server.listen(port, "0.0.0.0", () => {
  console.info(`version-exporter listening on port ${port}`);
  exporter.start();
});

let shuttingDown = false;
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.info(`Received ${signal}; shutting down`);
  await exporter.stop();
  server.close((error) => {
    if (error) {
      console.error("HTTP server shutdown failed:", error);
      process.exitCode = 1;
    }
  });
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
