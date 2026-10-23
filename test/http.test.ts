import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { requestJson } from "../src/http.js";
import type { AddressInfo } from "node:net";

test("enforces a total request timeout", async () => {
  const server = createServer((request, response) => {
    setTimeout(() => {
      if (!response.destroyed) {
        response.end(JSON.stringify({ version: "1.0" }));
      }
    }, 100);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;

  try {
    await assert.rejects(
      requestJson(`http://127.0.0.1:${address.port}/`, { timeoutMs: 10 }),
      /timed out/,
    );
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test("rejects unsuccessful HTTP status codes", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(503);
    response.end("unavailable");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;

  try {
    await assert.rejects(
      requestJson(`http://127.0.0.1:${address.port}/`, { timeoutMs: 1_000 }),
      /status 503/,
    );
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});
