import { MatrixEventHandler } from "./handlers/matrix-events";
import { MatrixClient, createClient, RoomEvent, EventType, ClientEvent, SyncState } from "matrix-js-sdk";
const MatrixLogger = require("matrix-js-sdk/lib/logger").logger;
// Force SDK logger to error and filter noisy Olm session wait spam.
try {
  (MatrixLogger as any).setLevel?.((process.env.MATRIX_SDK_LOG_LEVEL || "error").toLowerCase());
  const originalFactory = (MatrixLogger as any).methodFactory;
  if (originalFactory) {
    (MatrixLogger as any).methodFactory = function (methodName: string, logLevel: number, loggerName: string) {
      const raw = originalFactory.call(this, methodName, logLevel, loggerName);
      return function (this: any, ...args: any[]) {
        const first = typeof args[0] === "string" ? args[0] : "";
        // Suppress repetitive SDK logs:
        // - "[getSessionInfoForDevice] Waiting for Olm session ..."
        // - Any variants containing "Waiting for Olm session"
        if (first.includes("getSessionInfoForDevice") || first.includes("Waiting for Olm session")) {
          return;
        }
        return (raw as any).apply(this, args as any);
      };
    };
    // Re-apply level so the new methodFactory takes effect
    (MatrixLogger as any).setLevel?.((MatrixLogger as any).getLevel?.());
  }
} catch {}
import * as Olm from "@matrix-org/olm";
import { formatDate } from "./utils";
import { LocalStorage } from "node-localstorage";
import { LocalStorageCryptoStore } from "matrix-js-sdk/lib/crypto/store/localStorage-crypto-store";
import PersistentMemoryStore from "./store/persistent-store";
/** Minimal fetch options used in Matrix bootstrap mode (avoid importing legacy fetcher) */
type FetchOptions = Record<string, any>;
import RabbitMQSubscriber from "./messaging/subscriber";
import RabbitMQPublisher from "./messaging/publisher";
import { EgressConsumer } from "./messaging/egress";
import { MatrixActions } from "./handlers/matrix-actions";
import { MatrixMongoStore } from "./handlers/matrix-mongo-store";
import { Database } from "./handlers/database";
import mongoose from "mongoose";
import * as cli from "./cli/ui";
import config from "./config";
import * as readline from "readline";

type FetcherLike = {
  newFetchAllMessages: (maxMessages: number, options?: FetchOptions) => Promise<any>;
};

function askYesNo(question: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`${question} [y/N]: `, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase().startsWith("y"));
    });
  });
}

let activeVerifier: any = null;
let activeSas: any = null;
let pendingVerifierDecision: "confirm" | "cancel" | null = null;

// Track which transactions we've bound to (prevents duplicate verification sessions)
const boundTxns = new Set<string>();
const begunHandshakeTxns = new Set<string>();
// Store pending verification requests, mapping transaction ID to the request object.
const pendingVerificationRequests = new Map<string, any>();

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.on("line", async (line) => {
  const text = (line || "").trim().toLowerCase();

  // Only act when a verifier is active; otherwise queue only a confirm
  if (!activeVerifier) {
    if (text === "y" || text === "yes") {
      pendingVerifierDecision = "confirm";
      cli.printLog("Queued SAS confirm. It will be applied when the verifier is ready.");
    } else if (text === "n" || text === "no") {
      cli.printLog("No verifier active yet; ignoring cancel. Type 'y' to queue a confirm once SAS appears.");
    } else {
      cli.printLog("Input ignored. Type 'y' to confirm or 'n' to cancel when SAS is shown.");
    }
    return;
  }

  // Verifier is active: handle explicit confirm/cancel; ignore other input
  try {
    if (text === "y" || text === "yes") {
      // Await both steps: confirm() then verify() sends our MAC and awaits completion
      if (activeSas?.confirm) {
        await activeSas.confirm();
      } else if (typeof activeVerifier.confirm === "function") {
        await activeVerifier.confirm();
      }
      await activeVerifier.verify();
      activeSas = null;
      cli.print("Confirmed SAS locally. Waiting for Element to finish…");
    } else if (text === "n" || text === "no") {
      activeVerifier.cancel?.();
      cli.printError("SAS declined locally. Verification cancelled.");
    } else {
      cli.printLog("Input ignored. Type 'y' to confirm or 'n' to cancel.");
    }
  } catch (e) {
    cli.printError(`Verification action failed: ${e}`);
  }
  // 'done'/'cancel' handlers will clear activeVerifier
});

export class MatrixMessengerApp {
	private matrixARCReadyTimestamp: Date | null = null;
	private mqSubscriber: RabbitMQSubscriber;
	private mqPublisher: RabbitMQPublisher;
	private client: MatrixClient | null = null;
	private isBootstrapMode: boolean;
	private database: Database;

	private readonly authenticationDatabaseUri: string;
	private readonly collectionNamePrefix: string;
	private readonly appMessageBrokerUrl: string;
	private readonly appDatabaseUri: string;
	private readonly appUser: string;

	constructor(isBootstrap = false) {
		this.isBootstrapMode = isBootstrap;

		// Use appropriate config based on mode
		this.appMessageBrokerUrl = config.appMessageBrokerUrl;
		this.appDatabaseUri = config.appDatabaseUri;
		this.appUser = config.appUser;
		cli.printLog(`App Message Broker URL: ${this.appMessageBrokerUrl}`);
		cli.printLog(`App Database URI: ${this.appDatabaseUri}`);
		cli.printLog(`App User: ${this.appUser}`);

		// construct needed values for the MongoDB connection
		this.authenticationDatabaseUri = `${this.appDatabaseUri}/remoteAuth?authSource=admin`;
		this.collectionNamePrefix = config.collectionNamePrefix || this.appUser.toLowerCase() + "MatrixSession";

		// Only instantiate messaging components in non-bootstrap mode
		this.mqSubscriber = new RabbitMQSubscriber(this.appMessageBrokerUrl);
		this.mqPublisher = new RabbitMQPublisher(this.appMessageBrokerUrl);
		this.database = new Database();
	}

	/**
	 * Start the Matrix application in debug fetch mode
	 */
	async startDebugFetch(targetUser: string): Promise<void> {
		try {
			cli.printIntro();
			await this.initializeDatabase();

			// No MQ needed for debug fetch
			// Create client
			this.client = await this.createMatrixClient();
			const client = this.client as MatrixClient;

			cli.printLoading();

			client.on(ClientEvent.Sync, (state: SyncState, prevState: SyncState | null) => {
				if (state === SyncState.Prepared) {
					cli.print("Matrix client ready! Starting debug fetch...");
					this.performDebugFetch(client, targetUser);
				}
			});

			await client.startClient({
  initialSyncLimit: config.matrixInitialSyncLimit || 250
});
		} catch (error) {
			this.handleError(error);
		}
	}

	private async performDebugFetch(client: MatrixClient, targetUser: string): Promise<void> {
		try {
			// Convert target user to Matrix format if needed
			const matrixUserId = targetUser.startsWith("@") ? targetUser : `@${targetUser}`;

			// Find rooms with this user
			const rooms = client.getRooms();
			const targetRooms = rooms.filter((room) => {
				const members = room.getMembers();
				return members.some((member) => member.userId === matrixUserId);
			});

			if (targetRooms.length === 0) {
				cli.printError(`No rooms found with user ${matrixUserId}`);
				process.exit(1);
			}

			cli.print(`Found ${targetRooms.length} rooms with ${matrixUserId}`);

			// Get recent messages from the first room
			const room = targetRooms[0];
			const timeline = room.getLiveTimeline();
			const events = timeline.getEvents().slice(-4); // Get last 4 events

			cli.print(`Found ${events.length} recent messages`);

			if (events.length > 0) {
				events.forEach((event, index) => {
					if (event.getType() === EventType.RoomMessage) {
						const timestamp = new Date(event.getTs()).toISOString();
						const sender = event.getSender();
						const content = event.getContent();
						const from = sender === config.matrixUserId ? "Me" : "Other";
						cli.print(`[${index}] [${timestamp}] ${from}: ${content.body || "[No body]"}`);
					}
				});
			} else {
				cli.print("No messages found.");
			}

			cli.print("Debug fetch completed.");
			process.exit(0);
		} catch (error) {
			cli.printError(`Debug fetch failed: ${error}`);
			process.exit(1);
		}
	}

	/**
	 * Initialize the database connection
	 */
	private async initializeDatabase(): Promise<void> {
		if (!this.appDatabaseUri) {
			throw new Error("MongoDB connection URI is not configured");
		}

		const logModeMsg = this.isBootstrapMode ? "Bootstrap Mode" : "Normal Mode";
		const logMsg = `Connecting to database at ${this.appDatabaseUri} in ${logModeMsg}`;

cli.printLog(logMsg);
await this.database.connect();

		await mongoose.connect(this.authenticationDatabaseUri, {
			serverSelectionTimeoutMS: 5000,
			retryWrites: true
		});

		cli.print("Connected to ARC DB.");
	}

/**
 * Create and configure the Matrix client
 */
private async createMatrixClient(): Promise<MatrixClient> {
if (!config.matrixHomeserver || !config.matrixUserId) {
throw new Error("Matrix homeserver and user ID must be configured");
}

// Initialize Olm for encryption
try {
cli.print("Loading Olm library for encryption...");
await Olm.init();
// Set the global Olm object for the Matrix SDK
(global as any).Olm = Olm;
cli.print("Olm library loaded and configured successfully");
} catch (error) {
cli.printError(`Failed to load Olm library: ${error}`);
cli.printError("Continuing without encryption support");
}

try {
  (MatrixLogger as any).setLevel?.((config.matrixSdkLogLevel || "error").toLowerCase());
} catch {}
cli.print(`Creating Matrix client for ${config.matrixUserId} on ${config.matrixHomeserver}`);

// Check if we have stored credentials
const credStore = new MatrixMongoStore({
mongoose,
collectionNamePrefix: this.collectionNamePrefix
});

let accessToken = config.matrixAccessToken;
let deviceId = config.matrixDeviceId;

// Try to load from credential store if not in config
if (!accessToken || !deviceId) {
  const stored = await credStore.getStoredCredentials();
  if (stored) {
    accessToken = stored.accessToken;
    deviceId = stored.deviceId;
    cli.print("Using stored Matrix credentials");
  }
}

// If we don't have credentials, we need to login first to get them
if (!accessToken) {
if (!config.matrixPassword) {
throw new Error("Matrix password must be provided for initial login");
}

cli.print("Logging in to Matrix to obtain credentials...");

// Create a temporary client just for login
const tempClient = createClient({
baseUrl: config.matrixHomeserver,
userId: config.matrixUserId
});

const loginResponse = await tempClient.login("m.login.password", {
user: config.matrixUserId,
password: config.matrixPassword,
initial_device_display_name: config.matrixDeviceName
});

accessToken = loginResponse.access_token;
deviceId = loginResponse.device_id;

/** Store credentials for future use */
await credStore.storeCredentials(accessToken, deviceId);
cli.print("Matrix login successful, credentials stored");
}

const cryptoStore = new LocalStorageCryptoStore(new LocalStorage(".matrix-crypto"));

// Persistent sync store to avoid replay on restart (token-only persistence)
let persistentStore: any;
try {
  persistentStore = new PersistentMemoryStore(new LocalStorage(".matrix-store"));
  await persistentStore.startup();
  cli.printLog("PersistentMemoryStore initialized for sync token.");
} catch (e) {
  cli.printError(`Failed to initialize persistent store; using in-memory: ${e}`);
}

/**
 * Secret Storage policy:
 * - Default: service mode (no SSSS). Provide no-op callbacks so SDK won't try to use SSSS.
 * - If MATRIX_RECOVERY_KEY_B64 (32-byte base64) is provided, return that key to allow importing cross-signing/backup.
 */
const cryptoCallbacks: any = (() => {
  const rawEnv = config.matrixRecoveryKeyB64;

  const deriveKey = (val: string): Uint8Array | null => {
    try {
      if (!val) return null;
      // Strip surrounding quotes and normalize whitespace
      const trimmed = (val || "").trim().replace(/^"(.*)"$/, "$1");

      // 1) Try base64 (remove spaces/newlines)
      try {
        const b64 = trimmed.replace(/\s+/g, "");
        const buf = Buffer.from(b64, "base64");
        if (buf.length === 32) {
          cli.printLog("[SSSS] Using base64 32-byte recovery key from env");
          return new Uint8Array(buf);
        }
      } catch {}

      // 2) Try Element-style human-readable recovery key (groups with spaces)
      try {
        // Lazy require to avoid bundling path issues
        const { decodeRecoveryKey } = require("matrix-js-sdk/lib/crypto/recoverykey");
        const key: Uint8Array = decodeRecoveryKey(trimmed);
        if (key && key.length === 32) {
          cli.printLog("[SSSS] Decoded human-readable recovery key from env");
          return key;
        }
      } catch (e) {
        cli.printError(`[SSSS] Failed to decode human-readable recovery key: ${e}`);
      }

      return null;
    } catch (e) {
      cli.printError(`[SSSS] deriveKey error: ${e}`);
      return null;
    }
  };

  const key = rawEnv ? deriveKey(rawEnv) : null;
  if (key) {
    return {
      // Provide the raw 32-byte SSSS key so SDK can import cross-signing / backup secrets.
      getSecretStorageKey: async (_name?: string) => ({ key }),
      cacheSecretStorageKey: async () => {},
      // Prevent secret requests after verification
      onSecretRequested: async () => undefined
    };
  }

  // Service mode: do not participate in SSSS. This avoids post-SAS secret pulls that flip verification UI.
  return {
    getSecretStorageKey: async (_name?: string) => null,
    cacheSecretStorageKey: async () => {},
    onSecretRequested: async () => undefined
  };
})();

// Now create the actual client with known deviceId for encryption support
const client = createClient({
baseUrl: config.matrixHomeserver,
userId: config.matrixUserId,
accessToken: accessToken,
deviceId: deviceId,
store: persistentStore,
cryptoStore: cryptoStore,
cryptoCallbacks
});
try {
  (client as any).setGlobalBlacklistUnverifiedDevices?.(false);
  (client as any).getCrypto?.()?.setGlobalBlacklistUnverifiedDevices?.(false);
  (client as any).setGlobalErrorOnUnknownDevices?.(false);
  cli.printLog("Crypto configured: do not blacklist unverified devices; unknown-device errors disabled.");
} catch {}

/** Set a human-friendly permanent device name (so SAS prompts show a solid client name) */
try {
  if (deviceId && typeof (client as any).setDeviceDetails === "function") {
    await (client as any).setDeviceDetails(deviceId, { display_name: config.matrixDeviceName });
    cli.print(`Matrix device name set to "${config.matrixDeviceName}" for device ${deviceId}`);
  } else {
    cli.printLog("Matrix SDK does not expose setDeviceDetails; device display name set via login payload.");
  }
} catch (e) {
  cli.printError(`Failed to set Matrix device name: ${e}`);
}

/** Initialize encryption support */
try {
cli.print("Initializing Matrix encryption...");
await client.initCrypto();
cli.print("Matrix encryption initialized successfully");

try {
  await (client as any).crypto?.checkOneTimeKeyCountsAndUploadIfNeeded?.();
  cli.printLog("[keys] Uploaded device/one-time keys if needed");
} catch {}


// Try to restore key backup using SSSS if recovery key is provided.
// This helps decrypt historical messages by loading Megolm session keys.
try {
  const cryptoAny = (client as any).crypto;
  if (cryptoAny) {
    // Refresh our own device keys/trust first
    try { await client.downloadKeys?.([config.matrixUserId], true); } catch {}

    if (config.matrixRecoveryKeyB64) {
      let restored = false;
      try {
        // Preferred (newer SDKs)
        if (typeof cryptoAny.restoreKeyBackupWithSecretStorage === "function") {
          await cryptoAny.restoreKeyBackupWithSecretStorage();
          restored = true;
        }
      } catch {}

      if (!restored) {
        try {
          // Legacy manager API
          const mgr = cryptoAny.backupManager;
          if (mgr?.restoreBackup) {
            await mgr.restoreBackup();
            restored = true;
          }
        } catch {}
      }

      if (!restored) {
        try {
          // Fallback: check and enable backup; some SDKs hydrate keys on enable
          await cryptoAny.checkKeyBackupAndEnable?.();
          restored = true;
        } catch {}
      }

      if (restored) {
        cli.print("Attempted key backup restore via SSSS.");
      } else {
        cli.printLog("SSSS provided but backup restore API not available in this SDK version.");
      }
    } else {
      cli.printLog("No MATRIX_RECOVERY_KEY_B64 provided; running in service mode without SSSS restore.");
    }
  }
} catch (e) {
  cli.printError(`Key backup restore attempt failed: ${e}`);
}
} catch (error) {
cli.printError(`Matrix encryption initialization failed: ${error}`);
// Continue without encryption - we'll handle encrypted events differently
}

return client;
}

	/**
	 * Initialize dependencies (handlers, publishers, etc.)
	 */
	private initializeDependencies(client: MatrixClient): {
		fetcher: FetcherLike;
		matrixActions: MatrixActions;
		matrixEventHandler: MatrixEventHandler;
	} {
		// Matrix service mode: we don't need the WhatsApp Fetcher. Provide a stub with the required API.
		const fetcherInstance: FetcherLike = {
			newFetchAllMessages: async (maxMessages: number, _options?: FetchOptions) => {
				cli.printLog(`Bootstrap fetcher stub (Matrix): skipping backfill (max=${maxMessages}).`);
				return {
					totalContacts: 0,
					processedContacts: 0,
					totalMessages: 0,
					processedMessages: 0,
					currentContact: "",
					startTime: new Date()
				};
			}
		};
		const matrixEventHandler = new MatrixEventHandler(this.mqPublisher, this.database);
		const matrixActions = new MatrixActions(client);

		return { fetcher: fetcherInstance, matrixActions, matrixEventHandler };
	}

	/**
	 * Set up all event handlers for the Matrix client
	 */
private setupEventHandlers(
client: MatrixClient,
fetcher: FetcherLike,
matrixActions: MatrixActions,
matrixEventHandler: MatrixEventHandler,
fetchOptions?: FetchOptions
): void {
/** Track requested (roomId, sessionId) to avoid duplicate spam */
const requestedKeySessions = new Set<string>();

/**
 * Try to recover missing Megolm session keys for an undecryptable event.
 * Uses whatever API the SDK exposes in this version (compat shims with optional chaining).
 */
async function tryRequestMissingKeys(c: MatrixClient, ev: any, roomIdHint?: string) {
  try {
    const wc = ev?.getWireContent?.() ?? ev?.getContent?.() ?? {};
    const sessionId = wc?.session_id;
    const algorithm = wc?.algorithm;
    const senderKey = wc?.sender_key ?? ev?.getSenderKey?.();
    const roomId = ev?.getRoomId?.() ?? roomIdHint;

    // De-duplicate room_key requests per (roomId, sessionId)
    const dedupeKey = sessionId && roomId ? `${roomId}|${sessionId}` : null;
    if (dedupeKey && requestedKeySessions.has(dedupeKey)) {
      cli.printLog(`[keys] Skipping duplicate key request for ${ev?.getId?.()} session=${sessionId}`);
      return;
    }

    if (!sessionId || !algorithm || !roomId) {
      cli.printLog(`[keys] Cannot request keys for ${ev?.getId?.()}: missing session_id/algorithm/roomId`);
    } else {
      let requested = false;

      // Cancel any incomplete/bad prior requests for this event, then re-issue using the safe helper.
      try { await (c as any).crypto?.cancelAndResendEventRoomKeyRequest?.(ev); } catch {}

      try { await (c as any).crypto?.requestKeysForEvent?.(ev); requested = true; } catch {}
      if (!requested) { try { await (c as any).requestKeysForEvent?.(ev); requested = true; } catch {} }

      cli.printLog(`[keys] Requested room key for ${ev?.getId?.()} session=${sessionId}${senderKey ? ` senderKey=${senderKey}` : ""}`);
      if (dedupeKey) {
        requestedKeySessions.add(dedupeKey);
        // Expire after 10 minutes to allow retry later if needed
        setTimeout(() => requestedKeySessions.delete(dedupeKey), 10 * 60 * 1000);
      }

    }

    // Ensure we have Olm sessions to the sender and to ourselves so to-device replies can reach us
    const sender = ev?.getSender?.();
    const ids: string[] = [];
    if (sender) ids.push(sender);
    if (config.matrixUserId) ids.push(config.matrixUserId);
    try { await (c as any).crypto?.ensureOlmSessionsForUsers?.(ids); } catch {}
  } catch (e) {
    cli.printError(`[keys] Key request failed for ${ev?.getId?.()}: ${e}`);
  }
}

/**
 * Scan recent timelines for undecryptable events and request keys.
 */
async function scanAndRequestMissingKeys(c: MatrixClient, lookbackPerRoom = 200) {
  try {
    const rooms = c.getRooms?.() || [];
    for (const room of rooms) {
      const timeline = room.getLiveTimeline?.();
      const events = timeline?.getEvents?.() || [];
      const slice = events.slice(-lookbackPerRoom);
      for (const ev of slice) {
        const type = ev?.getType?.();
        const failed =
          type === "m.room.encrypted" ||
          (typeof ev?.isDecryptionFailure === "function" && ev.isDecryptionFailure());
        if (failed) {
          await tryRequestMissingKeys(c, ev, room.roomId);
        }
      }
    }
    cli.printLog(`[keys] Scan complete; requested keys for undecryptable events`);
  } catch (e) {
    cli.printError(`[keys] Scan failed: ${e}`);
  }
}

/**
 * Ensure Olm sessions exist with all joined room members (and our own user),
 * to allow to-device key traffic to succeed.
 */
async function ensureSessionsForAllRooms(c: MatrixClient) {
  try {
    const users = new Set<string>();
    const rooms = c.getRooms?.() || [];
    for (const room of rooms) {
      const members = room.getMembersWithMembership?.("join") || room.getMembers?.() || [];
      for (const m of members) {
        if (m?.userId) users.add(m.userId);
      }
    }
    // Always ensure a session to ourselves too (enables SSSS/backup/verification traffic)
    const selfId = (c as any).getUserId?.() || config.matrixUserId;
    if (selfId) users.add(selfId);

    const ids = Array.from(users);
    if (ids.length) {
      try { await c.downloadKeys?.(ids, true); } catch {}
      try { await (c as any).crypto?.ensureOlmSessionsForUsers?.(ids); } catch {}
      cli.printLog(`[keys] Ensured Olm sessions for ${ids.length} users across ${rooms.length} rooms`);
    }
  } catch (e) {
    cli.printError(`[keys] ensureSessionsForAllRooms failed: ${e}`);
  }
}

// Sync state events
		client.on(ClientEvent.Sync, (state: SyncState, prevState: SyncState | null) => {
			if (state === SyncState.Prepared) {
				const egress = new EgressConsumer(this.mqPublisher, matrixActions);
				egress.start().catch((err) => cli.printError(`EgressConsumer start error: ${err?.message || err}`));

				this.matrixARCReadyTimestamp = new Date();
				cli.print(`${this.appUser} Matrix client ready ${formatDate(this.matrixARCReadyTimestamp)}.`);
				cli.printOutro();

/**
 * After initial sync, proactively request keys for any undecryptable history,
 * then keep scanning periodically to pick up late key gossip or device trust changes.
 */
void scanAndRequestMissingKeys(client).catch((e) => cli.printError(`[keys] Post-sync scan error: ${e}`));

const KEY_SCAN_INTERVAL_MS = 60000; // 1 minute
setInterval(() => {
  void scanAndRequestMissingKeys(client).catch((e) => cli.printError(`[keys] periodic scan error: ${e}`));
}, KEY_SCAN_INTERVAL_MS);

				/** Proactively ensure Olm sessions with all joined members and self */
void ensureSessionsForAllRooms(client);

const OLM_SESSION_REFRESH_MS = 5 * 60 * 1000; // 5 minutes
setInterval(() => {
  void ensureSessionsForAllRooms(client);
}, OLM_SESSION_REFRESH_MS);

// Periodically ensure our one-time keys are topped up
const OTK_REFRESH_MS = 10 * 60 * 1000;
setInterval(() => {
  void (client as any).crypto?.checkOneTimeKeyCountsAndUploadIfNeeded?.();
}, OTK_REFRESH_MS);

// Bootstrap-specific logic: fetch messages with progress tracking
				if (this.isBootstrapMode) {
					this.startMessageFetching(fetcher, fetchOptions);
				}
			}
		});

// Room timeline events (messages, reactions, etc.)
client.on(RoomEvent.Timeline, async (event, room, toStartOfTimeline) => {
if (toStartOfTimeline || !room) return; // We only want recent events

const eventType = event.getType();
cli.printLog(`[timeline] ${room?.roomId} ${event.getId?.()} type=${eventType} from=${event.getSender?.()} decryptionFailed=${typeof (event as any).isDecryptionFailure==="function" ? (event as any).isDecryptionFailure() : eventType==="m.room.encrypted"}`);

if (eventType === EventType.RoomMessage) {
  try { const c = event.getContent?.() || {}; cli.printLog(`[timeline] handling RoomMessage id=${event.getId?.()} from=${event.getSender?.()} body=${c.body || "[no body]"}`); } catch {}
// Handle decrypted messages
if (event.getSender() !== config.matrixUserId) {
await matrixEventHandler.handleIncomingMessage(client, event, room);
} else {
await matrixEventHandler.handleMessageCreation(client, event, room);
}
} else if (eventType === "m.room.encrypted") {
cli.printLog(`Encrypted event from ${event.getSender()} - waiting for decryption...`);

// Ensure we have up-to-date device keys for the sender
{
  const senderId = event.getSender?.();
  if (senderId) {
    try { await client.downloadKeys?.([senderId], true); } catch {}
  }
}

// Proactively request missing keys once we see an encrypted event
await tryRequestMissingKeys(client, event, room?.roomId);

// Process after decryption: the SDK emits a 'decrypted' event on the MatrixEvent
(event as any).once?.("Event.decrypted", async () => {
  try {
    const clearType = (event as any).getClearType?.() || event.getType();
    const failed = typeof (event as any).isDecryptionFailure === "function"
      ? (event as any).isDecryptionFailure()
      : clearType === "m.room.encrypted";

    if (failed) {
      cli.printLog(`Decryption failed for ${event.getId()}; requesting keys and will retry when received`);
      await tryRequestMissingKeys(client, event, room?.roomId);
      return;
    }

    try {
      const c = (event as any).getContent?.() || (event as any).getClearContent?.() || {};
      cli.printLog(`[decrypted] ${room?.roomId} ${event.getId?.()} clearType=${clearType} from=${event.getSender?.()} body=${c.body || "[no body]"}`);
    } catch {}

    if (clearType === EventType.RoomMessage) {
      if (event.getSender() !== config.matrixUserId) {
        await matrixEventHandler.handleIncomingMessage(client, event, room);
      } else {
        await matrixEventHandler.handleMessageCreation(client, event, room);
      }
    } else if (clearType === EventType.Reaction) {
      await matrixEventHandler.handleIncomingReaction(client, event, room);
    } else {
      cli.printLog(`Decrypted event ${event.getId()} with unsupported clear type: ${clearType}`);
    }
  } catch (e) {
    cli.printError(`Decrypted-event handling failed: ${e}`);
  }
});
} else if (eventType === EventType.Reaction) {
  cli.printLog(`[timeline] handling Reaction id=${event.getId?.()} relates_to=${JSON.stringify((event.getContent?.()||{})["m.relates_to"]||{})}`);
  await matrixEventHandler.handleIncomingReaction(client, event, room);
}
});
client.on(RoomEvent.Receipt, async (event, room) => {
  try {
    await matrixEventHandler.handleIncomingReceipt(client, event, room);
  } catch (e) {
    cli.printError(`Receipt handling failed: ${e}`);
  }
});

/**
 * Handle device verification requests (SAS / QR)
 */


// We accept the request and store it so we can retrieve it later when the 'start' event arrives.
(client as any).on?.("crypto.verification.request", async (req: any) => {
  const txnId = req.transactionId;
  cli.printLog(`[verification.request] ${txnId}`);
  if (activeVerifier) {
    cli.printLog(`[verification.request] Ignored (busy with ${activeVerifier.transactionId})`);
    return;
  }

  // store the request by txn so we can recover on 'start'
  if (txnId) pendingVerificationRequests.set(txnId, req);

  try {
    await req.accept?.();
    cli.printLog("Accepted; waiting for Element to start…");
  } catch (e) {
    cli.printError(`accept() failed: ${e}`);
  }

  // fallback: when SDK attaches a verifier to the request, bind immediately (we'll drive with verify())
  req.on?.("change", () => {
    try {
      const v = (req as any).verifier;
      const tid = v?.transactionId || req.transactionId;
      if (!v || !tid) return;
      if (boundTxns.has(tid)) return;
      cli.printLog(`[request.change] binding to req.verifier for txn ${tid}`);
      bindVerifierEventHandlers(v, tid);
    } catch (e) {
      cli.printError(`[request.change] error: ${e}`);
    }
  });
});

// Preferred path: the SDK tells you the verifier explicitly.
(client as any).on?.("crypto.verification.start", (verifier: any, req?: any) => {
  const txnId = verifier?.transactionId || req?.transactionId || req?.transaction_id;
  if (!txnId) return cli.printLog("start without txnId; ignoring");
  if (boundTxns.has(txnId)) return cli.printLog(`already bound ${txnId}`);
  bindVerifierEventHandlers(verifier, txnId);
});

// This function attaches all the necessary event handlers to a verifier.
function bindVerifierEventHandlers(verifier: any, txnId: string) {
  if (!txnId) {
    cli.printError("[bindVerifier] Transaction ID is missing. Cannot bind.");
    return;
  }

  // Prevent binding handlers multiple times to the same verifier
  if (boundTxns.has(txnId)) {
    cli.printLog(`[bindVerifier] Already bound handlers for txn ${txnId}.`);
    return;
  }
  boundTxns.add(txnId);
  activeVerifier = verifier;
  cli.printLog(`[bindVerifier] methods=${JSON.stringify((verifier as any).methods)} txn=${txnId}`);
  cli.printLog(`[bindVerifier] Binding handlers for txn ${txnId}`);

  verifier.on?.("show_sas", async (ev: any) => {
    const emojis = (ev.emoji || ev.sas?.emoji || []).map((e: any) => Array.isArray(e) ? e[0] : e).join(" ");
    const decimals = (ev.decimal || ev.sas?.decimal || []).join(" ");
    cli.print(`SAS Emoji: ${emojis}`);
    cli.print(`SAS Decimals: ${decimals}`);
    cli.print("If they match in Element, type 'y' then Enter.");
    activeSas = ev;

    if (pendingVerifierDecision === "confirm") {
      pendingVerifierDecision = null;
      cli.printLog(`[show_sas] Applying queued confirmation for txn ${txnId}`);
      await ev.confirm?.();
      await verifier.verify(); // sends MAC; waits for peer MAC
      cli.print("Confirmed SAS locally (queued).");
    }
  });

  verifier.on?.("done", () => {
    cli.print("✅ Verification finished.");
    cleanup();
  });

  verifier.on?.("cancel", (e: any) => {
    cli.printError(`Verification cancelled: ${e?.code || e?.reason || "unknown"}`);
    cleanup();
  });

  function cleanup() {
    cli.printLog(`[cleanup] Cleaning up for txn ${txnId}`);
    activeVerifier = null;
    activeSas = null;
    boundTxns.delete(txnId);
    begunHandshakeTxns.delete(txnId);
    pendingVerificationRequests.delete?.(txnId); // ok if undefined
    pendingVerifierDecision = null;
  }

  // Drive the SAS handshake: this sends 'accept' if we're the acceptor and waits for show_sas
  (async () => {
    if (begunHandshakeTxns.has(txnId)) return;
    begunHandshakeTxns.add(txnId);
    try {
      cli.printLog(`[bindVerifier] calling verify() to progress SAS for txn ${txnId}`);
      await verifier.verify();
      cli.printLog(`[bindVerifier] verify() resolved; awaiting 'done' or peer confirmation…`);
    } catch (e) {
      cli.printError(`[bindVerifier] verify() failed: ${e}`);
    }
  })();
}

// Listen for raw to-device events (log and robustly attach/begin verification)
client.on(ClientEvent.ToDeviceEvent, async (event: any) => {
  const eventType = event.getType();
  if (eventType === "m.room_key.withheld") {
  const content = event.getContent();
  const code = content?.code || content?.reason || content?.withheld;
  const session = content?.session_id;
  const alg = content?.algorithm;
  cli.printError(`[keys] Key withheld: code=${code || "unknown"} session=${session || "?"} alg=${alg || "?"}`);
  return;
}
if (!eventType?.startsWith("m.key.verification.")) return;

  const content = event.getContent();
  const txnId = content?.transaction_id;
  cli.printLog(
    `[ToDeviceEvent] Received '${eventType}' for txn ${txnId}. Active verifier txn: ${activeVerifier?.transactionId}`
  );

  // If the peer sent START, bind to the SDK-created verifier; do NOT create a new one or send our own START
  if (eventType === "m.key.verification.start" && txnId && !boundTxns.has(txnId)) {
    const req = pendingVerificationRequests.get(txnId);
    if (!req) {
      cli.printError(`[start] no stored request for txn ${txnId}`);
      return;
    }
    const v = (req as any).verifier;
    if (v) {
      cli.printLog(`[start] binding to request.verifier for txn ${txnId}`);
      bindVerifierEventHandlers(v, txnId);
    } else {
      cli.printLog(`[start] request.verifier not yet present for txn ${txnId}; waiting for req.change…`);
    }
  }
});

// Room membership events
client.on(RoomEvent.MyMembership, (room, membership, prevMembership) => {
if (membership === "join") {
cli.printLog(`Joined room: ${room.name || room.roomId}`);
}
});

// Error handling
client.on(ClientEvent.SyncUnexpectedError, (error) => {
cli.printError(`Matrix sync error: ${error.message}`);
});
}

/**
 * Start message fetching for bootstrap mode
 */
private async startMessageFetching(fetcher: FetcherLike, fetchOptions?: FetchOptions, maxMessages = Infinity): Promise<void> {
try {
await fetcher.newFetchAllMessages(maxMessages, fetchOptions);
} catch (error: any) {
cli.printError(`Failed to fetch messages: ${error.message}`);
}
}

/**
 * Start the Matrix application
 */
async start(messageFetchOptions?: FetchOptions): Promise<void> {
try {
// Print appropriate intro
if (this.isBootstrapMode) {
cli.printBootstrap();
} else {
cli.printIntro();
}

// Initialize database
await this.initializeDatabase();

await this.mqSubscriber.connect();
await this.mqPublisher.connect();

// Create client
this.client = await this.createMatrixClient();

// Initialize dependencies
const { fetcher, matrixActions, matrixEventHandler } = this.initializeDependencies(this.client);

// Setup event handlers
this.setupEventHandlers(this.client!, fetcher, matrixActions, matrixEventHandler, messageFetchOptions);

cli.printLoading();

// Start Matrix Client
await this.client.startClient({
  initialSyncLimit: config.matrixInitialSyncLimit || 250
});
} catch (error) {
this.handleError(error);
}
}

/**
 * Handle application errors
 */
private handleError(error: any): void {
if (error.name === "MongoServerError" && error.code === 18) {
cli.printError("Authentication failed - please check your database credentials");
} else if (error.message?.includes("Matrix")) {
cli.printError(`Matrix client error: ${error.message}`);
} else {
cli.printError(`Failed to start application: ${error.message}`);
}
this.shutdown();
process.exit(1);
}

/**
 * Gracefully shutdown the application
 */
async shutdown(): Promise<void> {
if (this.client) {
this.client.stopClient();
}

// Only close messaging components if they were initialized
await this.mqPublisher.close();
await this.mqSubscriber.close();
await this.database.disconnect();
await mongoose.disconnect();
}
}
