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
	appId: string;

	// Central/CANON extras
	wid?: string; // this bridge's WhatsApp JID if available (fallback to appId)
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
}

// Config
export const config: IConfig = Object.freeze({
	// Access control
	appMessageBrokerUrl: process.env.APP_MESSAGE_BROKER_URL || "",
	appDatabaseUri: process.env.APP_DATABASE_URI || "",
	appServerUrl: process.env.APP_SERVER_URL || "",
	verbose: process.env.VERBOSE === "true",
	appName: process.env.APP_NAME || "",
	appUser: process.env.APP_USER || "",
	dbName: process.env.DB_NAME || "",
	appId: process.env.APP_ID || "",

	// Central/CANON extras (defaults per spec if envs missing)
	wid: process.env.WID || process.env.APP_ID, // fallback to appId
	collectionNamePrefix:
		process.env.COLLECTION_NAME_PREFIX ||
		(process.env.APP_USER ? `${process.env.APP_USER.toLowerCase()}MatrixSession` : "ach9MatrixSession"),
	primaryDbMessages: process.env.PRIMARY_DB_MESSAGES || "ach9MatrixHistory",
	primaryDbAcks: process.env.PRIMARY_DB_ACKS || "ach9MatrixSession",
	authDb: process.env.AUTH_DB || "remoteAuth",
	clusterName: process.env.MONGO_CLUSTER || "arc_matrix",

	// Matrix-specific configuration
	matrixHomeserver: process.env.MATRIX_HOMESERVER || "https://matrix.org",
	matrixUserId: process.env.MATRIX_USER_ID || "",
	matrixAccessToken: process.env.MATRIX_ACCESS_TOKEN,
	matrixDeviceId: process.env.MATRIX_DEVICE_ID,
	matrixDeviceName: process.env.MATRIX_DEVICE_NAME || "ARC Matrix Messenger",
	matrixPassword: process.env.MATRIX_PASSWORD,
	matrixRecoveryKeyB64: process.env.MATRIX_RECOVERY_KEY_B64,
matrixSdkLogLevel: process.env.MATRIX_SDK_LOG_LEVEL || "error",
matrixInitialSyncLimit: parseInt(process.env.MATRIX_INITIAL_SYNC_LIMIT || "250", 10),
logLevel: process.env.LOG_LEVEL || "info"
});

export default config;
