import type { ServerResponse } from "http";

export type ApiErrorCategory =
  | "bad_request"
  | "not_found"
  | "conflict"
  | "forbidden"
  | "internal";

export interface ApiErrorPayload {
  code: string;
  message: string;
  category: ApiErrorCategory;
  retryable: boolean;
  action: string;
}

export class WebApiError extends Error {
  readonly status: number;
  readonly payload: ApiErrorPayload;

  constructor(status: number, payload: ApiErrorPayload) {
    super(payload.message);
    this.name = "WebApiError";
    this.status = status;
    this.payload = payload;
  }
}

export function makeApiError(
  status: number,
  code: string,
  message: string,
  opts: {
    category?: ApiErrorCategory;
    retryable?: boolean;
    action?: string;
  } = {},
): WebApiError {
  return new WebApiError(status, {
    code,
    message,
    category: opts.category ?? categoryForStatus(status),
    retryable: opts.retryable ?? status >= 500,
    action: opts.action ?? defaultAction(status),
  });
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
}

export function sendApiError(res: ServerResponse, error: WebApiError): void {
  sendJson(res, error.status, { error: error.payload });
}

export function sendUnknownError(res: ServerResponse, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  sendApiError(res, makeApiError(500, "web.internal_error", message, {
    category: "internal",
    retryable: true,
    action: "稍后重试；如果持续失败，请打开健康中心或运行 sky doctor。",
  }));
}

function categoryForStatus(status: number): ApiErrorCategory {
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status >= 500) return "internal";
  return "bad_request";
}

function defaultAction(status: number): string {
  if (status === 403) return "请从本机同源页面访问 Skyloom Web，或检查绑定地址与来源。";
  if (status === 404) return "检查 Agent、会话或 API 路径是否存在。";
  if (status === 409) return "等待当前 Agent 完成，或先停止生成后再重试。";
  if (status >= 500) return "稍后重试；如果持续失败，请打开健康中心或运行 sky doctor。";
  return "修正请求参数后重试。";
}
