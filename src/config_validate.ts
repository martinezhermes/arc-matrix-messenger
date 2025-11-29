import config, { IConfig } from "./config";

function isNonEmpty(s?: string): boolean {
  return !!(s && String(s).trim().length > 0);
}

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

export function validateConfig(cfg: IConfig = config): void {
  // Core
  assert(isNonEmpty(cfg.appMessageBrokerUrl), "ARC_MESSAGE_BROKER_URL is required");
  assert(isNonEmpty(cfg.appDatabaseUri), "ARC_DATABASE_URI is required (must include DB name)");
  assert(isNonEmpty(cfg.dbName), "DB_NAME is required");
  assert(isNonEmpty(cfg.arcUserId), "ARC_USER_ID is required");

  // Matrix
  assert(isNonEmpty(cfg.matrixHomeserver), "MATRIX_HOMESERVER is required");
  assert(isNonEmpty(cfg.matrixUserId), "MATRIX_USER_ID is required (e.g., @user:server)");

  const hasPassword = isNonEmpty(cfg.matrixPassword);
  const hasTokenPair = isNonEmpty(cfg.matrixAccessToken) && isNonEmpty(cfg.matrixDeviceId);
  assert(hasPassword || hasTokenPair, "Provide MATRIX_USER_PASSWORD or MATRIX_ACCESS_TOKEN + MATRIX_DEVICE_ID");

  // Formats
  assert(cfg.matrixUserId.startsWith("@") && cfg.matrixUserId.includes(":"), "MATRIX_USER_ID must be like @user:server");

  // Numbers
  assert(typeof cfg.matrixInitialSyncLimit === "number" && (cfg.matrixInitialSyncLimit as number) > 0, "MATRIX_CLIENT_SYNC_LIMIT must be a positive number");
}

export default validateConfig;

