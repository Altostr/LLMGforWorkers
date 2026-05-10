export const dynamic = "force-dynamic";

import { z } from "zod";
import { comparePassword, hashPassword } from "@/lib/auth";
import { gatewayDb, type DbUser } from "@/lib/db";
import { ensureWebUser } from "@/lib/guards";
import { jsonError, jsonOk } from "@/lib/http";
import { friendlyCredentialPayloadError } from "@/lib/validation";

const schema = z.object({
  current_password: z.string().min(1),
  new_password: z.string().min(8),
});

export async function PUT(request: Request) {
  const guard = await ensureWebUser(request);
  if ("error" in guard) return guard.error;

  const body = await request.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) return jsonError(friendlyCredentialPayloadError(parsed.error), 400);

  const user = await gatewayDb.get<DbUser>(
    "SELECT * FROM users WHERE id = ? AND deleted_at IS NULL",
    guard.auth.user.id,
  ) as DbUser;

  const ok = await comparePassword(parsed.data.current_password, user.password_hash);
  if (!ok) return jsonError("当前密码不正确。", 400);

  const nextHash = await hashPassword(parsed.data.new_password);
  await gatewayDb.run("UPDATE users SET password_hash = ? WHERE id = ?", nextHash, user.id);

  return jsonOk({ ok: true, message: "密码修改成功。" });
}
