import { NextResponse } from "next/server";
import { scrubHiddenPeople } from "@/lib/hidden-people";

/**
 * Pass a wiki-server response through to the client with hidden people
 * (see hidden-people.ts) removed. Non-JSON bodies are streamed unchanged.
 */
export async function scrubbedProxyResponse(res: Response): Promise<NextResponse> {
  const contentType = res.headers.get("content-type") ?? "application/json";
  if (!contentType.includes("json")) {
    return new NextResponse(res.body, {
      status: res.status,
      headers: { "content-type": contentType },
    });
  }
  const scrubbed = scrubHiddenPeople(await res.json());
  if (scrubbed === null) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  return NextResponse.json(scrubbed, { status: res.status });
}
