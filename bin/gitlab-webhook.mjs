import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { UserError } from "../src/core.js";
import { reviewSettings } from "../src/review-config.js";
import { ReviewInbox } from "../src/review-inbox.js";

const MAX_BODY_BYTES = 1024 * 1024;

function respond(response, status, data) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(data));
}

function authorized(actual, expected) {
  if (typeof actual !== "string") return false;
  const received = Buffer.from(actual);
  const configured = Buffer.from(expected);
  return received.length === configured.length && timingSafeEqual(received, configured);
}

function readBody(request, maximum) {
  return new Promise((resolveBody, reject) => {
    let size = 0;
    let settled = false;
    const chunks = [];
    request.on("data", (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > maximum) {
        settled = true;
        chunks.length = 0;
        reject(new RangeError("Request body is too large."));
        return;
      }
      chunks.push(chunk);
    });
    request.once("end", () => {
      if (!settled) resolveBody(Buffer.concat(chunks).toString("utf8"));
    });
    request.once("error", reject);
  });
}

export function createWebhookServer({ inbox, secret, ready = true, maxBodyBytes = MAX_BODY_BYTES }) {
  const server = createServer(async (request, response) => {
    const path = request.url?.split("?", 1)[0];
    if (path === "/health" && request.method === "GET") {
      respond(response, 200, { ok: true, service: "mmp-gitlab-webhook", configured: Boolean(secret && ready), ...inbox.status() });
      return;
    }
    if (path !== "/webhooks/gitlab") {
      request.resume();
      respond(response, 404, { error: "Not found." });
      return;
    }
    if (request.method !== "POST") {
      request.resume();
      response.setHeader("Allow", "POST");
      respond(response, 405, { error: "POST is required." });
      return;
    }
    if (!secret || !ready) {
      request.resume();
      respond(response, 503, { error: "Configure the webhook secret, watched user, and allowed projects first." });
      return;
    }
    if (!authorized(request.headers["x-gitlab-token"], secret)) {
      request.resume();
      respond(response, 401, { error: "Webhook authentication failed." });
      return;
    }
    if (request.headers["content-type"]?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
      request.resume();
      respond(response, 415, { error: "Content-Type must be application/json." });
      return;
    }
    if (Number(request.headers["content-length"]) > maxBodyBytes) {
      request.resume();
      response.setHeader("Connection", "close");
      respond(response, 413, { error: "Request body is too large." });
      return;
    }
    try {
      const body = await readBody(request, maxBodyBytes);
      const payload = JSON.parse(body);
      const result = inbox.ingest({
        eventType: request.headers["x-gitlab-event"],
        eventId: request.headers["x-gitlab-event-uuid"] || request.headers["webhook-id"],
        payload,
      });
      respond(response, result.status === "duplicate" ? 200 : 202, result);
    } catch (error) {
      if (error instanceof RangeError) {
        response.setHeader("Connection", "close");
        respond(response, 413, { error: "Request body is too large." });
      } else if (error instanceof SyntaxError || error instanceof UserError) {
        respond(response, 400, { error: "Invalid GitLab event payload or headers." });
      } else {
        respond(response, 500, { error: "Could not store the webhook event." });
      }
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const settings = reviewSettings();
    const inbox = new ReviewInbox(settings);
    const ready = Boolean((settings.username || settings.userId) && settings.projectIds.length);
    const server = createWebhookServer({ inbox, secret: settings.webhookSecret, ready });
    server.on("error", () => { inbox.close(); process.stderr.write("Could not start the local webhook receiver.\n"); process.exitCode = 1; });
    server.listen(settings.port, "127.0.0.1", () => {
      process.stderr.write(`GitLab webhook receiver: http://127.0.0.1:${settings.port}/webhooks/gitlab\n`);
      if (!settings.webhookSecret || !ready) process.stderr.write("Webhook configuration is incomplete; authenticated requests are disabled.\n");
    });
    const shutdown = () => server.close(() => { inbox.close(); });
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  } catch {
    process.stderr.write("Invalid review receiver settings. Check the documented environment variables.\n");
    process.exitCode = 1;
  }
}
