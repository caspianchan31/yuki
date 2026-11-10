// v1.7.2 对话快: a conversation's history travels compressed. The JSON routes already did (the
// proxy in front compresses them); this stream did not, and opening a conversation downloaded
// its last turns as they are (some hundred KB of very repetitive events).
import { Readable } from "node:stream";
import { constants, createGzip } from "node:zlib";

/** The history stream (`.../connect`) gzipped when the client takes gzip. Each chunk is flushed
 * as it comes, so a reply still running at the end of the history arrives word by word. Any other
 * response, and one already encoded, is returned as it is. */
export function squeezed(request: Request, path: string, response: Response): Response {
  if (!path.endsWith("/connect") || !response.body || response.status !== 200) return response;
  if (response.headers.get("content-encoding")) return response;
  if (!/\bgzip\b/i.test(request.headers.get("accept-encoding") ?? "")) return response;
  const gzip = createGzip({ flush: constants.Z_SYNC_FLUSH });
  const source = Readable.fromWeb(response.body as never);
  // The reader left (another conversation, a reload): stop reading the history for it.
  gzip.on("close", () => source.destroy());
  source.on("error", (error) => gzip.destroy(error));
  const headers = new Headers(response.headers);
  headers.set("Content-Encoding", "gzip");
  headers.append("Vary", "Accept-Encoding");
  headers.delete("Content-Length");
  return new Response(Readable.toWeb(source.pipe(gzip)) as never, {
    status: response.status,
    headers,
  });
}
