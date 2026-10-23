import http from "node:http";
import https from "node:https";
import type { HttpRequestOptions, JsonRequester } from "./types.js";

const DEFAULT_MAX_RESPONSE_BYTES = 1_048_576;

export const requestJson: JsonRequester = (
  url,
  { timeoutMs, headers = {}, ca, maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES }: HttpRequestOptions,
) => {
  const parsedUrl = new URL(url);
  const transport = parsedUrl.protocol === "https:" ? https : http;
  if (!["http:", "https:"].includes(parsedUrl.protocol)) {
    return Promise.reject(new Error(`Unsupported URL protocol "${parsedUrl.protocol}"`));
  }

  return new Promise<unknown>((resolve, reject) => {
    const request = transport.request(
      parsedUrl,
      {
        headers: { accept: "application/json", ...headers },
        ...(ca ? { ca } : {}),
      },
      (response) => {
        let body = "";
        let responseBytes = 0;

        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          responseBytes += Buffer.byteLength(chunk);
          if (responseBytes > maxResponseBytes) {
            response.destroy(new Error(`Response exceeded ${maxResponseBytes} bytes`));
            return;
          }
          body += chunk;
        });
        response.on("error", reject);
        response.on("end", () => {
          if (response.statusCode === undefined || response.statusCode < 200 || response.statusCode >= 300) {
            reject(new Error(`HTTP request failed with status ${response.statusCode}`));
            return;
          }

          try {
            resolve(JSON.parse(body));
          } catch (error) {
            reject(new Error(`Response was not valid JSON: ${errorMessage(error)}`, { cause: error }));
          }
        });
      },
    );

    const timeout = setTimeout(() => {
      request.destroy(new Error(`Request timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    request.on("close", () => clearTimeout(timeout));
    request.on("error", reject);
    request.end();
  });
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
