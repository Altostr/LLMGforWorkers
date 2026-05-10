export const dynamic = "force-dynamic";

import { z } from "zod";
import { ensureAdmin } from "@/lib/guards";
import { jsonError, jsonOk } from "@/lib/http";
import { getGatewaySettings, setGatewaySettings } from "@/lib/settings";

const schema = z.object({
  registration_enabled: z.boolean(),
  password_login_enabled: z.boolean(),
  upstream_retry_enabled: z.boolean(),
  upstream_retry_max_attempts: z.number().int().min(1).max(10),
  upstream_circuit_breaker_enabled: z.boolean(),
  public_base_url: z.string().optional(),
});

export async function GET(request: Request) {
  const guard = await ensureAdmin(request);
  if ("error" in guard) return guard.error;

  const settings = await getGatewaySettings();
  return jsonOk({ message: "系统设置获取成功。", data: settings });
}

export async function PUT(request: Request) {
  const guard = await ensureAdmin(request);
  if ("error" in guard) return guard.error;

  const body = await request.json().catch(() => null);
  const parsed = schema.safeParse(body);
  if (!parsed.success) return jsonError("请求参数不正确", 400);

  if (!parsed.data.password_login_enabled) {
    return jsonError("账号密码登录不能关闭。", 400);
  }

  await setGatewaySettings(parsed.data);

  const updated = await getGatewaySettings();
  return jsonOk({ message: "系统设置更新成功。", data: updated });
}
