import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { postText, requestJson } from "../src/http.js";
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

test("connects through a Unix socket and posts text bodies", { skip: process.platform === "win32" }, async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "version-exporter-"));
  const socketPath = join(dir, "docker.sock");
  let received = "";
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      received = `${request.method} ${request.url} ${request.headers["content-type"] ?? ""} ${body}`;
      response.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));

  try {
    assert.deepEqual(await requestJson("http://localhost/containers/json", { timeoutMs: 1_000, socketPath }), { ok: true });
    assert.match(received, /^GET \/containers\/json /);
    await postText("http://localhost/import", "metric 1\n", { timeoutMs: 1_000, socketPath });
    assert.match(received, /^POST \/import text\/plain; version=0\.0\.4; charset=utf-8 metric 1\n$/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    await rm(dir, { recursive: true, force: true });
  }
});

test("posts text bodies over TCP", async () => {
  let received = "";
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      received = `${request.method} ${body}`;
      response.writeHead(204);
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;

  try {
    await postText(`http://127.0.0.1:${address.port}/api/v1/import/prometheus`, "up 1\n", { timeoutMs: 1_000 });
    assert.equal(received, "POST up 1\n");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});
