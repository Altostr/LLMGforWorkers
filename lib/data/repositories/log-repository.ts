import { gatewayDb, type DbBatchStatement, type GatewayDbAdapter } from "@/lib/db";
import { createLogStatement, type CreateLogInput } from "@/lib/chat-log-statement";
import { ensureLogsSchema } from "@/lib/logs-schema";

export { createLogStatement, type CreateLogInput };

export async function createLog(input: CreateLogInput, db: GatewayDbAdapter = gatewayDb) {
  await ensureLogsSchema(db);
  const statement = createLogStatement(input);
  await db.run(statement.sql, ...(statement.params ?? []));
}

export async function createLogs(inputs: CreateLogInput[], db: GatewayDbAdapter = gatewayDb) {
  if (inputs.length === 0) return;
  await ensureLogsSchema(db);
  await db.batch(inputs.map(createLogStatement) as DbBatchStatement[]);
}
