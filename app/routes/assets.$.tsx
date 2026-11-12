import { env } from "cloudflare:workers";
import type { Route } from "./+types/assets.$";

export async function loader({ params, request }: Route.LoaderArgs) {
  const key = params["*"];
  if (!key) {
    return new Response("Asset key required", { status: 400 });
  }

  const object = await env.quest_assets.get(key);
  if (!object) {
    return new Response("Not Found", { status: 404 });
  }

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  if (!headers.has("cache-control")) {
    headers.set("cache-control", "public, max-age=31536000, immutable");
  }

  const ifNoneMatch = request.headers.get("if-none-match");
  if (ifNoneMatch && ifNoneMatch === object.httpEtag) {
    return new Response(null, { status: 304, headers });
  }

  return new Response(object.body, {
    status: 200,
    headers,
  });
}
