import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { QUESTION_SET_VERSION, POLICY_VERSION } from "../config.js";
import { analyze } from "../analyze.js";
import { isShieldError } from "../errors.js";
import type { JevClient } from "../jev/client.js";
import { parseAnalyzeBody, readJsonBody } from "./schema.js";

export interface ServerOptions {
  client?: JevClient;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function sendError(res: ServerResponse, error: unknown): void {
  if (isShieldError(error)) {
    sendJson(res, error.status, {
      error: { code: error.code, message: error.message },
    });
    return;
  }
  sendJson(res, 500, {
    error: {
      code: "jev_error",
      message: "Shield failed before producing a verdict.",
    },
  });
}

export function createServer(options: ServerOptions = {}) {
  return createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (req.method === "GET" && url.pathname === "/health") {
        sendJson(res, 200, {
          ok: true,
          question_set_version: QUESTION_SET_VERSION,
          policy_version: POLICY_VERSION,
        });
        return;
      }
      if (url.pathname !== "/v1/analyze") {
        sendJson(res, 404, {
          error: { code: "invalid_request", message: "Not found." },
        });
        return;
      }
      if (req.method !== "POST") {
        sendJson(res, 405, {
          error: { code: "invalid_request", message: "Use POST." },
        });
        return;
      }
      const body = parseAnalyzeBody(await readJsonBody(req));
      const analyzeOptions = options.client ? { client: options.client } : {};
      const result = await analyze(body, analyzeOptions);
      sendJson(res, 200, result);
    } catch (error) {
      sendError(res, error);
    }
  });
}
