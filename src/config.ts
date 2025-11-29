import * as process from "process";
import * as dotenv from "dotenv";
dotenv.config();

// Config Interface
export interface IConfig {
	// Access control
	appMessageBrokerUrl: string;
	appDatabaseUri: string;
	appServerUrl: string;
	verbose: boolean;
	appUser: string;
	appName: string;
	dbName: string;
	arcUserId: string;

	// Central/CANON extras
	wid?: string; // this bridge's WhatsApp JID if available (fallback to arcUserId)
	collectionNamePrefix?: string; // session naming prefix for RemoteAuth/MongoStore
	primaryDbMessages: string; // e.g. "ach9WhatsappHistory"
	primaryDbAcks: string; // e.g. "ach9WhatsappSession"
	authDb: string; // e.g. "remoteAuth"
	clusterName?: string; // e.g. "arcRecursiveCore"

	// Matrix-specific configuration
	matrixHomeserver: string; // Matrix homeserver URL
	matrixUserId: string; // Matrix user ID (@user:server.com)
	matrixAccessToken?: string; // Stored access token
	matrixDeviceId?: string; // Stored device ID
	matrixDeviceName?: string; // Human-friendly device display name
	matrixPassword?: string; // Password for login (if using password auth)
	matrixRecoveryKeyB64?: string; // Optional recovery key for SSSS (base64 32-byte)
matrixSdkLogLevel?: string;    // SDK logger level: silent|error|warn|info|debug
logLevel?: string;             // App CLI log level: silent|error|warn|info|debug
  matrixInitialSyncLimit?: number; // initial sync event limit to reduce historical backfill

  // Phase 2 flags
  cmeEnabled?: boolean;            // enable Canonical Messenger Event storage
  publishReactions?: boolean;      // publish reaction ingress events
  publishReceipts?: boolean;       // publish receipt ingress events
}

// Config
export const config: IConfig = Object.freeze({
	// Access control
	appMessageBrokerUrl: process.env.ARC_MESSAGE_BROKER_URL || "",
	appDatabaseUri: process.env.ARC_DATABASE_URI || "",
	appServerUrl: process.env.APP_SERVER_URL || "",
	verbose: process.env.VERBOSE === "true",
	appName: process.env.APP_NAME || "",
	appUser: process.env.ARC_USER || "",
	dbName: process.env.DB_NAME || "",
	arcUserId: process.env.ARC_USER_ID || "",

	// Central/CANON extras (defaults per spec if envs missing)
	wid: process.env.WID || process.env.ARC_USER_ID, // fallback to arcUserId
	collectionNamePrefix:
		process.env.COLLECTION_NAME_PREFIX ||
		`${(process.env.DB_NAME || 'arcRecursiveCore').toLowerCase()}MatrixSession`,
	primaryDbMessages: process.env.PRIMARY_DB_MESSAGES || process.env.DB_NAME || "arcRecursiveCore",
	primaryDbAcks: process.env.PRIMARY_DB_ACKS || process.env.DB_NAME || "arcRecursiveCore",
	authDb: process.env.AUTH_DB || "remoteAuth",
	clusterName: process.env.MONGO_CLUSTER || "arc_matrix",

	// Matrix-specific configuration
	matrixHomeserver: process.env.MATRIX_HOMESERVER || "https://matrix.org",
	matrixUserId: process.env.MATRIX_USER_ID || "",
	matrixAccessToken: process.env.MATRIX_ACCESS_TOKEN,
	matrixDeviceId: process.env.MATRIX_DEVICE_ID,
	matrixDeviceName: process.env.MATRIX_CLIENT_DEVICE_NAME || "ARC Matrix Messenger",
	matrixPassword: process.env.MATRIX_USER_PASSWORD,
  matrixRecoveryKeyB64: process.env.MATRIX_USER_RECOVERY_KEY_B64,
  matrixSdkLogLevel: process.env.MATRIX_SDK_LOG_LEVEL || "error",
  matrixInitialSyncLimit: parseInt(process.env.MATRIX_CLIENT_SYNC_LIMIT || "250", 10),
  // Phase 2 flags
  cmeEnabled: (process.env.CME_ENABLED || "false").toLowerCase() === "true",
  publishReactions: (process.env.PUBLISH_REACTIONS || "true").toLowerCase() === "true",
  publishReceipts: (process.env.PUBLISH_RECEIPTS || "false").toLowerCase() === "true",
  logLevel: process.env.LOG_LEVEL || "info"
});

export default config;
