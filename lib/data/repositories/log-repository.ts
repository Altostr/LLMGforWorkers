import { gatewayDb, type DbBatchStatement, type GatewayDbAdapter } from "@/lib/db";
import { createLogStatement, isMissingLogEventIdColumnError, type CreateLogInput } from "@/lib/chat-log-statement";

export { createLogStatement, type CreateLogInput };

export async function createLog(input: CreateLogInput, db: GatewayDbAdapter = gatewayDb) {
  try {
    const statement = createLogStatement(input);
    await db.run(statement.sql, ...(statement.params ?? []));
  } catch (error) {
    if (!isMissingLogEventIdColumnError(error)) throw error;

    const legacyStatement = createLogStatement(input, "legacy");
    await db.run(legacyStatement.sql, ...(legacyStatement.params ?? []));
  }
}

export async function createLogs(inputs: CreateLogInput[], db: GatewayDbAdapter = gatewayDb) {
  if (inputs.length === 0) return;
  try {
    await db.batch(inputs.map((input) => createLogStatement(input)) as DbBatchStatement[]);
  } catch (error) {
    if (!isMissingLogEventIdColumnError(error)) throw error;

    await db.batch(inputs.map((input) => createLogStatement(input, "legacy")) as DbBatchStatement[]);
  }
}
