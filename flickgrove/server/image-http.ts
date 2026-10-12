import { authorizeRead } from "./peer-http";
import type { HostService } from "./hosts";
import { IMAGE_UPLOAD_BYTES } from "./images";
export async function imageHttp(
  request: Request,
  service: HostService,
  origins: string[],
): Promise<Response | undefined> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/images")) return;
  const auth = authorizeRead(request, service, origins, ["GET", "POST"]);
  if (auth instanceof Response) return auth;
  const { headers, respond } = auth;
  try {
    const agent = url.searchParams.get("agent") ?? "";
    if (url.pathname === "/api/images" && request.method === "POST") {
      if (Number(request.headers.get("content-length")) > IMAGE_UPLOAD_BYTES)
        return respond({ error: "Image upload exceeds 20 MiB" }, 413);
      if (
        !request.headers.get("content-type")?.startsWith("multipart/form-data;")
      )
        return respond({ error: "Use image files" }, 415);
      const reader = request.body?.getReader();
      if (!reader) throw new Error("Missing images");
      const chunks = [];
      let size = 0;
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.length;
          if (size > IMAGE_UPLOAD_BYTES) {
            await reader.cancel();
            return respond({ error: "Image upload exceeds 20 MiB" }, 413);
          }
          chunks.push(chunk.value);
        }
      } finally {
        reader.releaseLock();
      }
      const form = await new Response(new Blob(chunks), {
        headers: { "Content-Type": request.headers.get("content-type")! },
      }).formData();
      const files = form.getAll("images");
      if (files.some((f) => !(f instanceof File)))
        throw new Error("Choose image files");
      const operation = url.searchParams.get("operation") ?? "";
      const encodedText = form.get("text");
      if (typeof encodedText !== "string")
        throw new Error("Missing message text");
      let text: unknown;
      try {
        text = JSON.parse(encodedText);
      } catch {
        throw new Error("Invalid message text");
      }
      if (typeof text !== "string") throw new Error("Invalid message text");
      const images = await service.uploadImages(
        agent,
        operation,
        text,
        files as File[],
      );
      return respond({ agent, operation, images });
    }
    const match = /^\/api\/images\/([a-f0-9]{64})\/(preview|original)$/.exec(
      url.pathname,
    );
    if (match && request.method === "GET") {
      const image = service.media(agent, match[1], match[2] === "preview");
      if (!image) return respond({ error: "Image missing or unreadable" }, 404);
      headers.set("Content-Type", image.mediaType);
      return new Response(image.bytes, { headers });
    }
    return respond({ error: "Image action not found" }, 404);
  } catch (error) {
    return respond(
      {
        error:
          error instanceof Error ? error.message : "Could not prepare image",
      },
      400,
    );
  }
}
