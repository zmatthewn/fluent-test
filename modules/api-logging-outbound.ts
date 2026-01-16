import { ZuploContext, ZuploRequest } from "@zuplo/runtime";

interface PolicyOptions {
  blobBaseUrl: string;
  sasAuth: string;
  debugEnabled?: boolean | string;
}

export default async function (
  response: Response,
  request: ZuploRequest,
  context: ZuploContext,
  options: PolicyOptions,
  policyName: string,
) {

/*

  if you want to debug log when doing local dev, you can set API_LOGGING_DEBUG_ENABLED env variable to "true" 
  this will console.log() ie:

    gateway    | [16:31:50.034] DEBUG [GET /fluent_getShippingLabel/:filename] Request received '/fluent_getShippingLabel/41_15019526502_1162_397732955577.png'
    gateway    | [16:31:50.034] DEBUG [GET /fluent_getShippingLabel/:filename] {"method":"GET","url":"/fluent_getShippingLabel/41_15019526502_1162_397732955577.png","hostname":"localhost","route":"/fluent_getShippingLabel/:filename"}
    gateway    | [16:31:50.038] DEBUG [GET /fluent_getShippingLabel/:filename] URL Rewriting to 'https://stzumbizappsdevmyskfa9q.blob.core.windows.net/zumiez-bizapps-dev/applications/proship/labels/41_15019526502_1162_397732955577.png?sv=...'
    gateway    | [16:31:50.121] DEBUG [GET /fluent_getShippingLabel/:filename] URL Rewrite received response 200 - OK in 83ms
    gateway    | [16:31:50.121] INFO  [GET /fluent_getShippingLabel/:filename] [api-logging] Starting log for http://localhost:9000/fluent_getShippingLabel/41_15019526502_1162_397732955577.png
    gateway    | [16:31:50.138] INFO  [GET /fluent_getShippingLabel/:filename] Logged request/response to applications/zuplo/api-logs/fluent_getShippingLabel/1768437110121.json
    gateway    | [16:31:50.138] INFO  [GET /fluent_getShippingLabel/:filename] [api-logging] Successfully logged http://localhost:9000/fluent_getShippingLabel/41_15019526502_1162_397732955577.png

*/

  const debugEnabled =
    options.debugEnabled === true || options.debugEnabled === "true";

  // validate policy options
  if (typeof options.blobBaseUrl !== "string") {
    throw new Error(
      `The option 'blobBaseUrl' on policy '${policyName}' must be a string. Received ${typeof options.blobBaseUrl}.`,
    );
  }
  if (typeof options.sasAuth !== "string") {
    throw new Error(
      `The option 'sasAuth' on policy '${policyName}' must be a string. Received ${typeof options.sasAuth}.`,
    );
  }

  // clone response since we need to read the body
  const responseClone = response.clone();

  if (debugEnabled) {
    context.log.info(`[api-logging] Starting log for ${request.url}`);
  }

  // waitUntil() my goat. fire off the logging but don't block the response
  context.waitUntil(
    logRequestResponse(request, responseClone, context, options, debugEnabled)
      .then(() => {
        if (debugEnabled) {
          context.log.info(`[api-logging] Successfully logged ${request.url}`);
        }
      })
      .catch((error) => {
        // always log errors i guess 
        context.log.error("[api-logging] Failed to log request/response to blob storage", {
          error: error.message,
          stack: error.stack,
        });
      }),
  );

  // return response immediateLY!!!
  return response;
}

// headers to strip from logs (case-insensitive)
const SENSITIVE_HEADERS = [
  "authorization",
  "x-api-key",
  "api-key",
  "cookie",
  "set-cookie",
  "x-auth-token",
  "x-access-token",
];

function stripSensitiveHeaders(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of headers.entries()) {
    if (SENSITIVE_HEADERS.includes(key.toLowerCase())) {
      result[key] = "[REDACTED]";
    } else {
      result[key] = value;
    }
  }
  return result;
}

async function logRequestResponse(
  request: ZuploRequest,
  response: Response,
  context: ZuploContext,
  options: PolicyOptions,
  debugEnabled: boolean,
) {
  const timestamp = Date.now();

  // going to serialize the req and the resp so we can add them both to a single file
  // request body was captured by the inbound policy and stashed in context.custom
  // (because by the time we get here, the body has already been consumed by the handler)

  const requestBody = context.custom.capturedRequestBody ?? "[No request body captured - is api-logging-inbound policy applied?]";
  const serializedRequest = {
    method: request.method,
    url: request.url,
    headers: stripSensitiveHeaders(request.headers),
    body: typeof requestBody === "object" ? JSON.stringify(requestBody) : requestBody,
  };

  const responseBody = await getResponseBody(response);
  const serializedResponse = {
    status: response.status,
    statusText: response.statusText,
    headers: stripSensitiveHeaders(response.headers),
    body: typeof responseBody === "object" ? JSON.stringify(responseBody) : responseBody,
  };

  // build the log entry
  const logEntry = {
    request: serializedRequest,
    response: serializedResponse,
    timestamp,
    requestId: context.requestId,
  };

  // get the route name from the request path (sanitize for blob storage path) because this will be used as the log filder inside applications/zuplo/api-logs/<routename>/
  const routeName = getRouteName(request.url);

  const blobPath = `applications/zuplo/api-logs/${routeName}/${timestamp}.json`;
  const blobUrl = `${options.blobBaseUrl}/${blobPath}?${options.sasAuth}`;

  // upload le fkn blobs
  const uploadResponse = await fetch(blobUrl, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "x-ms-blob-type": "BlockBlob",
    },
    body: JSON.stringify(logEntry, null, 2),
  });

  if (!uploadResponse.ok) {
    const errorText = await uploadResponse.text();
    throw new Error(
      `Failed to upload log to blob storage: ${uploadResponse.status} ${errorText}`,
    );
  }

  if (debugEnabled) {
    context.log.info(`[api-logging] Logged request/response to ${blobPath}`);
  }
}

function getRouteName(url: string): string {
  try {
    const urlObj = new URL(url);
    // get the first path segment as the route name
    const pathSegments = urlObj.pathname.split("/").filter(Boolean);
    // use the first segment, or 'root' if no path is provided ? idk
    const routeName = pathSegments[0] || "root";
    // sanitize: remove any characters that aren't safe for blob paths (ie proship:fluent route -> proshipfluent)
    return routeName.replace(/[^a-zA-Z0-9_-]/g, "_");
  } catch {
    return "unknown";
  }
}

async function getResponseBody(response: Response): Promise<unknown> {
  try {
    const contentType = response.headers.get("content-type") || "";

    if (contentType.includes("application/json")) {
      return await response.json();
    } else if (contentType.includes("text/")) {
      return await response.text();
    } else {
      // for binary data (images, etc.), just note the size for funsies
      const blob = await response.blob();
      return `[Binary data: ${blob.size} bytes, type: ${contentType}]`;
    }
  } catch {
    return "[Unable to read response body]";
  }
}
