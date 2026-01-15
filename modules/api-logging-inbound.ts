import { ZuploContext, ZuploRequest } from "@zuplo/runtime";

/*
  this inbound policy captures the request body before it gets consumed by the handler.
  it stashes the body in context.custom so the outbound policy can access it later.

  must be applied BEFORE any policy that reads the body.
*/

export default async function (
  request: ZuploRequest,
  context: ZuploContext,
) {
  try {
    // skip body capture for methods that don't have bodies
    if (request.method === "GET" || request.method === "HEAD" || request.method === "OPTIONS") {
      context.custom.capturedRequestBody = null;
      return request;
    }

    const contentType = request.headers.get("content-type") || "";
    const clonedRequest = request.clone();

    if (contentType.includes("application/json")) {
      context.custom.capturedRequestBody = await clonedRequest.json();
    } else if (contentType.includes("application/x-www-form-urlencoded")) {
      const text = await clonedRequest.text();
      const params = new URLSearchParams(text);
      const entries = Object.fromEntries(params.entries());

      // if there's only one field called 'content', just store its value directly (common ish pattern for xml payloads wrapped in form encoding)
      const keys = Object.keys(entries);
      if (keys.length === 1 && keys[0] === "content") {
        context.custom.capturedRequestBody = entries["content"];
      } else {
        context.custom.capturedRequestBody = entries;
      }
    } else if (contentType.includes("text/") || contentType.includes("application/xml") || contentType.includes("+xml")) {
      // text/*, application/xml, text/xml, application/soap+xml, etc.
      context.custom.capturedRequestBody = await clonedRequest.text();
    } else {
      // for binary data, just note that it exists
      const blob = await clonedRequest.blob();
      context.custom.capturedRequestBody = `[Binary data: ${blob.size} bytes, type: ${contentType}]`;
    }
  } catch {
    context.custom.capturedRequestBody = "[Unable to read request body]";
  }

  return request;
}
