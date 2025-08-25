import { Database, CollectionName } from "./database";
import { MatrixClient, MatrixEvent, Room, EventType } from "matrix-js-sdk";
import RabbitMQPublisher from "../messaging/publisher";
import * as cli from "../cli/ui";
import config from "../config";
import { ArcEvent } from "../types/arc-event";

// ID translation functions
function matrixToLegacyId(matrixId: string): string {
  // Store canonical Matrix IDs unchanged (e.g., @user:server, !room:server)
  return matrixId;
}

// Types compatible with existing WhatsApp structures
interface EnrichedMessage {
id: { id: string; _serialized: string };
from: string;
to: string;
author?: string;
participant?: string;
ack?: number;
type: string;
body: string;
timestamp: number;
serialId?: string;
}

interface EnrichedContact {
	name?: string;
	serialId?: string;
}

interface EnrichedReaction {
id: { id: string; _serialized: string };
msgId: { _serialized: string };
senderId: string;
reaction: string;
timestamp: number;
}

export class MatrixEventHandler {
	private publisher: RabbitMQPublisher;
		private database: Database;

	private readonly DEFAULT_REACTION_DELAY = 1000;

constructor(publisher: RabbitMQPublisher, database: Database) {
this.publisher = publisher;
this.database = database;
}

	// Canonical helpers (same as WhatsApp implementation)
	private topicOr_(t?: string | null): string {
		return t && String(t).trim() ? String(t) : "_";
	}

	private sessionId(): string {
		return config.wid || config.appId;
	}

	private signatureFor(primaryDb: string, collection: string): string {
		const cluster = config.clusterName || "arcRecursiveCore";
		const authDb = config.authDb || "remoteAuth";
		return `mongo://${cluster}/${primaryDb}#${collection}:${this.sessionId()}?authDb=${authDb}`;
	}

	private buildMessageEvent(enriched: EnrichedMessage): ArcEvent {
		return {
			_id: enriched.serialId,
			origin: `matrix:${enriched.from}`, // Change prefix from "whatsapp:" to "matrix:"
			source: "matrix", // Change from "whatsapp" to "matrix"
			signature: this.signatureFor(config.primaryDbMessages, "messages"),
			sender: enriched.from,
			author: enriched.author || enriched.from,
			recipient: enriched.to,
			content: { body: enriched.body, id: enriched.id, serialId: enriched.serialId },
			type: "message",
			appId: config.appId,
			timestamp: enriched.timestamp,
			topic: "_",
			v: 1,
			ackPolicy: "at-least-once",
			ttlMs: 600000
		};
	}

	private buildReactionEvent(reaction: EnrichedReaction, enrichedMsg: EnrichedMessage): ArcEvent {
		return {
			_id: reaction.msgId._serialized,
			origin: `matrix:${enrichedMsg.from}`,
			source: "matrix",
			signature: this.signatureFor(config.primaryDbMessages, "reactions"),
			sender: enrichedMsg.from,
			author: enrichedMsg.author || enrichedMsg.from,
			recipient: enrichedMsg.to,
			content: { emoji: reaction.reaction, targetMessageId: reaction.msgId._serialized },
			type: "reaction",
			appId: config.appId,
			timestamp: reaction.timestamp || enrichedMsg.timestamp,
			topic: "_",
			v: 1,
			ackPolicy: "at-least-once",
			ttlMs: 600000
		};
	}

	// Standardized RabbitMQ publishing (same as WhatsApp)
	private async publishEvent(ev: ArcEvent) {
		const rk = "ingress.matrix"; // Changed from "ingress.whatsapp"
		const ex = "arc.loop.ingress";
		const sigStr = typeof ev.signature === "string" ? ev.signature : JSON.stringify(ev.signature);
		cli.printLog(`→ Publish ingress: ex=${ex} rk=${rk} type=${ev.type} appId=${ev.appId} origin=${ev.origin} signature=${sigStr}`);
		// cli.printLog(`Event content: ${JSON.stringify(ev.content).substring(0, 100)}...`);
		cli.printLog(`Event complete metadata: ${JSON.stringify(ev)}`);
		await this.publisher.publishTopic(ex, rk, ev);
	}

	/**
	 * Convert Matrix event to WhatsApp-compatible message structure
	 */
private async translateMatrixEvent(matrixClient: MatrixClient, event: MatrixEvent, room: Room): Promise<EnrichedMessage> {
const sender = event.getSender();
const eventId = event.getId();
const roomId = room.roomId;

if (!sender || !eventId) {
  throw new Error("Invalid Matrix event: missing sender or event ID");
}

// Try to decrypt and wait if decryption is in progress
try {
  const maybeClient: any = matrixClient as any;
  if (typeof maybeClient.decryptEventIfNeeded === "function") {
    await maybeClient.decryptEventIfNeeded(event);
  }
  const anyEvent: any = event as any;
  if (typeof anyEvent.isBeingDecrypted === "function" && anyEvent.isBeingDecrypted()) {
    await anyEvent.getDecryptionPromise?.().catch(() => {});
  }
} catch {
  // ignore; fall back to whatever content is available
}

// Prefer clear content, then raw, then edited/new content wrapper
const rawContent: any = event.getContent?.() || {};
const clearContent: any = (event as any).getClearContent?.() || rawContent;
const baseContent: any = Object.keys(clearContent || {}).length ? clearContent : rawContent;
const effectiveContent: any = baseContent["m.new_content"] || baseContent;

// Determine recipient "to":
// - For DMs (2 joined members), use the other user's ID (WhatsApp-like shape)
// - For groups/rooms, use the room ID
let toLegacy = matrixToLegacyId(roomId);
try {
  const myUserId = (config.matrixUserId || "").trim();
  const joined = room.getJoinedMembers?.() || [];
  const isDm = joined.length === 2 && !!myUserId;
  if (isDm) {
    if (sender === myUserId) {
      // Outgoing in a DM: recipient is the other member
      const other = joined.find((m: any) => m?.userId && m.userId !== myUserId);
      if (other?.userId) toLegacy = matrixToLegacyId(other.userId);
    } else {
      // Incoming in a DM: recipient is us (my user id)
      toLegacy = matrixToLegacyId(myUserId);
    }
  }
} catch {
  // fallback keeps room-based recipient
}

return {
  id: { id: eventId, _serialized: eventId },
  from: matrixToLegacyId(sender),
  to: toLegacy,
  author: matrixToLegacyId(sender),
  type: this.getMessageType(effectiveContent?.msgtype || baseContent?.msgtype || "m.text"),
  body: effectiveContent?.body || effectiveContent?.formatted_body || baseContent?.body || "[No content]",
  timestamp: event.getTs(),
  serialId: eventId
};
}

	/**
	 * Convert Matrix message type to WhatsApp-compatible type
	 */
	private getMessageType(msgtype: string): string {
		switch (msgtype) {
			case "m.text":
				return "chat";
			case "m.image":
				return "image";
			case "m.video":
				return "video";
			case "m.audio":
				return "audio";
			case "m.file":
				return "document";
			case "m.location":
				return "location";
			default:
				return "chat";
		}
	}

	/**
	 * Convert Matrix user to WhatsApp-compatible contact
	 */
private translateMatrixUser(userId: string, displayName?: string): EnrichedContact {
return {
name: displayName || userId,
serialId: userId
};
}

/**
 * Handle incoming Matrix messages (equivalent to handleIncomingMessage)
 */
async handleIncomingMessage(matrixClient: MatrixClient, event: MatrixEvent, room: Room): Promise<void> {
await this.executeWithErrorLogging("Matrix Event Incoming Message Error", async () => {
// Handle both regular and decrypted messages
try {
  // Attempt decryption if needed to avoid "[No content]"
  const maybeClient: any = matrixClient as any;
  if (typeof maybeClient.decryptEventIfNeeded === "function") {
    await maybeClient.decryptEventIfNeeded(event);
  }
} catch {
  // ignore; SDK will emit decrypted later if available
}

const content = event.getContent();
const eventType = event.getType();

cli.printLog(`Processing ${eventType} from ${event.getSender()}: ${content?.body || "[encrypted/no body]"}`);

const [msgCollection, contactsCollection, ackCollection] = await this.database.getCollections(
  CollectionName.Messages,
  CollectionName.Contacts,
  CollectionName.Acknowledgements
);

const enrichedMessage = await this.translateMatrixEvent(matrixClient, event, room);
await this.addMatrixContact(matrixClient, enrichedMessage.from, contactsCollection);

// Store ACK in database only (no publishing)
const sender = event.getSender();
if (sender && sender !== config.matrixUserId) {
  // This is an incoming message, store ACK_READ (4)
  const ackDoc = {
    messageId: enrichedMessage.id._serialized,
    senderId: enrichedMessage.from,
    targetId: enrichedMessage.to,
    authorId: enrichedMessage.author || null,
    ackValue: 4, // ACK_READ
    ackType: "ACK_READ",
    timestamp: enrichedMessage.timestamp,
    messageType: enrichedMessage.type,
    body: enrichedMessage.body
  };
  await this.database.upsertAck(ackDoc, ackCollection, "MESSAGE_ACK");
  cli.printLog(`[ACK] Stored ACK_READ for incoming message ${enrichedMessage.id._serialized} (publishing disabled)`);
}

await this.database.upsertMessage(enrichedMessage, msgCollection, "MESSAGE_RECEIVED");

// Publish only the message event
const arcEvent = this.buildMessageEvent(enrichedMessage);
await this.publishEvent(arcEvent);

// If body was placeholder due to encryption, update the doc once decryption completes
const anyEventUpdate: any = event as any;
if (enrichedMessage.body === "[No content]" && anyEventUpdate && typeof anyEventUpdate.once === "function") {
  anyEventUpdate.once("Event.decrypted", async () => {
    try {
      const updated = await this.translateMatrixEvent(matrixClient, event, room);
      if (updated.body && updated.body !== "[No content]") {
        await this.database.upsertMessage(updated, msgCollection, "MESSAGE_DECRYPTED");
        const arcUpd = this.buildMessageEvent(updated);
        await this.publishEvent(arcUpd);
        cli.printLog(`🔓 Decrypted update for ${updated.id._serialized}: ${updated.body.substring(0, 50)}...`);
      }
    } catch (e) {
      this.logError("Deferred decrypt update error", e);
    }
  });
}

cli.printLog(`✅ Message processed and published: ${enrichedMessage.body.substring(0, 50)}...`);
});
}

	/**
	 * Handle message creation (our own messages)
	 */
async handleMessageCreation(matrixClient: MatrixClient, event: MatrixEvent, room: Room): Promise<void> {
await this.executeWithErrorLogging("Matrix Event Message Creation Error", async () => {
const enrichedMessage = await this.translateMatrixEvent(matrixClient, event, room);
const [messageCollection, contactsCollection] = await this.database.getCollections(
  CollectionName.Messages,
  CollectionName.Contacts
);

// Ensure both sides of the DM are recorded as contacts
await this.addMatrixContact(matrixClient, enrichedMessage.to, contactsCollection);
await this.addMatrixContact(matrixClient, enrichedMessage.from, contactsCollection);

// Persist our own message
await this.database.upsertMessage(enrichedMessage, messageCollection, "MESSAGE_CREATE");

// Publish to ingress just like incoming messages, so downstream sees full conversation
const arcEvent = this.buildMessageEvent(enrichedMessage);
await this.publishEvent(arcEvent);

// If body is not yet available (encrypted), schedule a deferred update after decryption
const anyEventUpdate: any = event as any;
if (enrichedMessage.body === "[No content]" && anyEventUpdate && typeof anyEventUpdate.once === "function") {
  anyEventUpdate.once("Event.decrypted", async () => {
    try {
      const updated = await this.translateMatrixEvent(matrixClient, event, room);
      if (updated.body && updated.body !== "[No content]") {
        await this.database.upsertMessage(updated, messageCollection, "MESSAGE_DECRYPTED");
        const arcUpd = this.buildMessageEvent(updated);
        await this.publishEvent(arcUpd);
        cli.printLog(`🔓 Decrypted update (self) for ${updated.id._serialized}: ${updated.body.substring(0, 50)}...`);
      }
    } catch (e) {
      this.logError("Deferred decrypt update error (self)", e);
    }
  });
}
});
}

/**
 * Handle Matrix reactions
 */
async handleIncomingReaction(matrixClient: MatrixClient, event: MatrixEvent, room: Room): Promise<void> {
await this.executeWithErrorLogging("Matrix Event Reaction Error", async () => {
const [reactionCollection, msgCollection] = await this.database.getCollections(
CollectionName.Reactions,
CollectionName.Messages
);

const content = event.getContent();
const relation = content["m.relates_to"];

if (!relation || relation.rel_type !== "m.annotation") {
cli.printError("Invalid reaction event structure");
return;
}

const targetEventId = relation.event_id;
const emoji = relation.key;
const sender = event.getSender();

if (!sender || !targetEventId || !emoji) {
cli.printError("Invalid reaction event: missing sender, target event ID, or emoji");
return;
}

// Create enriched reaction compatible with WhatsApp structure
const enrichedReaction: EnrichedReaction = {
id: { id: event.getId()!, _serialized: event.getId()! },
msgId: { _serialized: targetEventId },
senderId: matrixToLegacyId(sender),
reaction: emoji,
timestamp: event.getTs()
};

await this.database.upsertReaction(enrichedReaction, reactionCollection);
await this.delay(this.DEFAULT_REACTION_DELAY);

// Try to get the target message for enrichment
const targetEvent = room.findEventById(targetEventId);
if (targetEvent) {
  try {
    const maybeClient: any = matrixClient as any;
    if (typeof maybeClient.decryptEventIfNeeded === "function") {
      await maybeClient.decryptEventIfNeeded(targetEvent);
    }
  } catch {}
  const enrichedMessage = await this.translateMatrixEvent(matrixClient, targetEvent, room);
  await this.database.upsertMessage(enrichedMessage, msgCollection, "MESSAGE_REACTION");

  // DISABLED: Publishing reactions to RabbitMQ
  // const arcEvent = this.buildReactionEvent(enrichedReaction, enrichedMessage);
  // await this.publishEvent(arcEvent);
  cli.printLog(`[Reaction] Stored reaction ${emoji} from ${sender} on ${targetEventId} (publishing disabled)`);
}
});
}

/**
 * Handle Matrix read receipts (m.receipt) as ACK_READ upserts
 */
async handleIncomingReceipt(matrixClient: MatrixClient, event: MatrixEvent, room: Room): Promise<void> {
await this.executeWithErrorLogging("Matrix Event Receipt Error", async () => {
  const [ackCollection, msgCollection] = await this.database.getCollections(
    CollectionName.Acknowledgements,
    CollectionName.Messages
  );

  const content: any = event.getContent() || {};
  // content format:
  // {
  //   "$eventId": {
  //     "m.read": {
  //       "@user:server": { "ts": number }
  //     }
  //   }
  // }
  const eventIds = Object.keys(content);
  for (const targetEventId of eventIds) {
    const receiptsForEvent = content[targetEventId] || {};
    const readMap = receiptsForEvent["m.read"] || {};
    const readerUserIds = Object.keys(readMap);

    // Find the target event in the room to enrich ack with message info
    const targetEvent = room.findEventById?.(targetEventId);
    if (!targetEvent) continue;

    const enrichedMessage = await this.translateMatrixEvent(matrixClient, targetEvent, room);

    for (const reader of readerUserIds) {
      const ts = readMap[reader]?.ts || enrichedMessage.timestamp;
      const ackValue = 4; // ACK_READ (index in WhatsApp ACK_TYPES)
      const ackDoc = {
        messageId: targetEventId,
        senderId: enrichedMessage.from,
        targetId: enrichedMessage.to,
        authorId: enrichedMessage.author || null,
        ackValue,
        ackType: "ACK_READ",
        timestamp: ts,
        messageType: enrichedMessage.type,
        body: enrichedMessage.body
      };
      await this.database.upsertAck(ackDoc, ackCollection, "MESSAGE_ACK");
      // Avoid creating/updating a message with placeholder content from ACK path.
      if (enrichedMessage.body && enrichedMessage.body !== "[No content]") {
        await this.database.upsertMessage(enrichedMessage, msgCollection, "MESSAGE_ACK");
      }
      
      // DISABLED: Publishing ACKs to RabbitMQ
      // No ArcEvent publishing for receipts
      cli.printLog(`[Receipt] Stored read receipt from ${reader} for ${targetEventId} (publishing disabled)`);
    }
  }
});
}

/**
 * Add Matrix contact to database
 */
	private async addMatrixContact(matrixClient: MatrixClient, legacyContactId: string, contactsCollection: any): Promise<void> {
		await this.executeWithErrorLogging(`Failed to fetch/upsert contact for ${legacyContactId}`, async () => {
			// Convert legacy ID back to Matrix format to get user info
const finalUserId = legacyContactId;
if (!finalUserId.startsWith("@")) {
  cli.printLog(`Skipping contact upsert for non-user id: ${finalUserId}`);
  return;
}

			try {
				// Try to get user profile
				const profile = await matrixClient.getProfileInfo(finalUserId);
				const enrichedContact = this.translateMatrixUser(finalUserId, profile.displayname);

				await this.database.upsertContact(enrichedContact, contactsCollection);
				cli.printLog(`Contact upserted: ${enrichedContact.name || enrichedContact.serialId}`);
			} catch (error) {
				// If we can't get profile, create basic contact
				const enrichedContact = this.translateMatrixUser(finalUserId);
				await this.database.upsertContact(enrichedContact, contactsCollection);
				cli.printLog(`Basic contact upserted: ${enrichedContact.serialId}`);
			}
		});
	}

	// Utility methods (same as WhatsApp implementation)
	private delay(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}

	private logError(context: string, error: unknown) {
		if (error instanceof Error) {
			cli.printError(`${context}: ${error.message}`);
		} else {
			cli.printError(`${context}: ${JSON.stringify(error)}`);
		}
	}

	private async executeWithErrorLogging(context: string, fn: () => Promise<void>) {
		try {
			await fn();
		} catch (error) {
			this.logError(context, error);
		}
	}
}
