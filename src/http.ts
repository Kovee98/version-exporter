import http from "node:http";
import https from "node:https";
import type { HttpRequestOptions, JsonRequester } from "./types.js";

const DEFAULT_MAX_RESPONSE_BYTES = 1_048_576;

interface RawRequestOptions extends HttpRequestOptions {
  method?: string;
  body?: string;
}

function request(
  url: string | URL,
  { timeoutMs, headers = {}, ca, maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES, socketPath, method = "GET", body }: RawRequestOptions,
): Promise<string> {
  const parsedUrl = new URL(url);
  const transport = parsedUrl.protocol === "https:" ? https : http;
  if (!["http:", "https:"].includes(parsedUrl.protocol)) {
    return Promise.reject(new Error(`Unsupported URL protocol "${parsedUrl.protocol}"`));
  }

  return new Promise<string>((resolve, reject) => {
    const outgoing = transport.request(
      parsedUrl,
      {
        method,
        headers: {
          ...headers,
          ...(body === undefined ? {} : { "content-length": String(Buffer.byteLength(body)) }),
        },
        ...(ca ? { ca } : {}),
        ...(socketPath ? { socketPath } : {}),
      },
      (response) => {
        let responseBody = "";
        let responseBytes = 0;

        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          responseBytes += Buffer.byteLength(chunk);
          if (responseBytes > maxResponseBytes) {
            response.destroy(new Error(`Response exceeded ${maxResponseBytes} bytes`));
            return;
          }
          responseBody += chunk;
        });
        response.on("error", reject);
        response.on("end", () => {
          if (response.statusCode === undefined || response.statusCode < 200 || response.statusCode >= 300) {
            reject(new Error(`HTTP request failed with status ${response.statusCode}`));
            return;
          }
          resolve(responseBody);
        });
      },
    );

    const timeout = setTimeout(() => {
      outgoing.destroy(new Error(`Request timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    outgoing.on("close", () => clearTimeout(timeout));
    outgoing.on("error", reject);
    outgoing.end(body);
  });
}

export const requestJson: JsonRequester = async (url, { headers = {}, ...options }: HttpRequestOptions) => {
  const body = await request(url, { ...options, headers: { accept: "application/json", ...headers } });
  try {
    return JSON.parse(body);
  } catch (error) {
    throw new Error(`Response was not valid JSON: ${errorMessage(error)}`, { cause: error });
  }
};

export type TextPoster = (url: string | URL, body: string, options: HttpRequestOptions) => Promise<void>;

export const postText: TextPoster = async (url, body, { headers = {}, ...options }) => {
  await request(url, {
    ...options,
    method: "POST",
    body,
    headers: { "content-type": "text/plain; version=0.0.4; charset=utf-8", ...headers },
  });
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}