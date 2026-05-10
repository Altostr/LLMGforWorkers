import { gatewayDb } from "@/lib/db";

export async function softDeleteUser(userId: string) {
  await gatewayDb.batch([
    {
      sql: "UPDATE keys SET enabled = 0, deleted_at = CURRENT_TIMESTAMP WHERE user_id = ? AND deleted_at IS NULL",
      params: [userId],
    },
    {
      sql: "UPDATE users SET enabled = 0, deleted_at = CURRENT_TIMESTAMP WHERE id = ? AND deleted_at IS NULL",
      params: [userId],
    },
  ]);
}

export async function softDeleteKey(keyId: string) {
  await gatewayDb.run(
    "UPDATE keys SET enabled = 0, deleted_at = CURRENT_TIMESTAMP WHERE id = ? AND deleted_at IS NULL",
    keyId,
  );
}

export async function softDeleteModel(modelId: string) {
  await gatewayDb.run(
    "UPDATE models SET enabled = 0, deleted_at = CURRENT_TIMESTAMP WHERE id = ? AND deleted_at IS NULL",
    modelId,
  );
}
