export const dynamic = "force-dynamic";

import { ensureUser } from "@/lib/guards";
import { jsonOk } from "@/lib/http";
import { getLegacyChatLogs } from "@/lib/log-queries";
import { parseBoundedInt } from "@/lib/utils";

export async function GET(request: Request) {
  const guard = await ensureUser(request);
  if ("error" in guard) return guard.error;

  const url = new URL(request.url);
  const limit = parseBoundedInt(url.searchParams.get("limit"), 50, 1, 200);
  const offset = parseBoundedInt(url.searchParams.get("offset"), 0, 0, Number.MAX_SAFE_INTEGER);

  return jsonOk(await getLegacyChatLogs({ userId: guard.auth.user.id, limit, offset }));
}
