import { Database, CollectionName } from "./database";
import { MatrixClient, MatrixEvent, Room, EventType } from "matrix-js-sdk";
import RabbitMQPublisher from "../messaging/publisher";
import * as cli from "../cli/ui";
import config from "../config";
import { ArcEvent } from "../types/arc-event";
import { MessengerEvent } from "../types/messenger-event";

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
	recipientId?: string;
	author?: string;
	participant?: string;
	ack?: number;
	type: string;
	body: string;
	timestamp: number;
	serialId?: string;
	roomId?: string;
	replyTo?: {
		eventId: string;
		senderId?: string;
		body?: string;
		timestamp?: number;
	};
	media?: {
		url?: string;
		info?: any;
	};
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
		// Phase 2: prefer Matrix user ID as the stable arcUserId; fallback to configured arcUserId
		return (config.matrixUserId && config.matrixUserId.trim()) || config.arcUserId;
	}

	private signatureFor(primaryDb: string, collection: string): string {
		const cluster = config.clusterName || "arcRecursiveCore";
		const authDb = config.authDb || "remoteAuth";
		return `mongo://${cluster}/${primaryDb}#${collection}:${this.sessionId()}?authDb=${authDb}`;
	}

	private getMsgType(enrichedType: string): string {
		switch (enrichedType) {
			case "chat":
				return "m.text";
			case "image":
				return "m.image";
			case "video":
				return "m.video";
			case "audio":
				return "m.audio";
			case "document":
				return "m.file";
			case "location":
				return "m.location";
			default:
				return "m.text";
		}
	}

	private buildMessageEvent(enriched: EnrichedMessage, encrypted: boolean = false): ArcEvent {
		const eventMs = enriched.timestamp || Date.now();
		const eventSeconds = Math.floor(eventMs / 1000);
		const contentBase = {
			// Canonical payload
			body: enriched.body,
			msgtype: this.getMsgType(enriched.type),
			event_id: enriched.serialId,
			event_ts: eventSeconds,
			...(enriched.replyTo ? { replyTo: enriched.replyTo } : {}),
			// Back-compat payload fields
			id: enriched.id,
			serialId: enriched.serialId
		};
		return {
			source: "messenger",
			arcUserId: this.sessionId(),
			eventId: enriched.serialId,
			roomId: enriched.roomId,
			senderId: enriched.from,
			timestamp: eventMs,
			type: "message",
			encrypted,
			content: {
				...contentBase,
				...(enriched.media ? { media: enriched.media } : {})
			},
			platform: "matrix",
			v: 1,
			ackPolicy: "at-least-once",
			ttlMs: 600000
		};
	}

	private buildReactionEvent(reaction: EnrichedReaction, enrichedMsg: EnrichedMessage): ArcEvent {
		const eventMs = reaction.timestamp || enrichedMsg.timestamp || Date.now();
		const eventSeconds = Math.floor(eventMs / 1000);
		return {
			source: "messenger",
			arcUserId: this.sessionId(),
			eventId: reaction.id._serialized,
			roomId: enrichedMsg.roomId,
			senderId: enrichedMsg.from,
			timestamp: eventMs,
			type: "reaction",
			encrypted: false,
			content: {
				// Canonical shape requirements
				body: reaction.reaction,
				event_id: reaction.id._serialized,
				event_ts: eventSeconds,
				// Reaction-specific fields
				emoji: reaction.reaction,
				targetMessageId: reaction.msgId._serialized
			},
			relatesTo: {
				eventId: reaction.msgId._serialized,
				relationType: "annotation"
			},
			platform: "matrix",
			v: 1,
			ackPolicy: "at-least-once",
			ttlMs: 600000
		};
	}

	private buildReceiptEvent(targetEventId: string, enrichedMsg: EnrichedMessage, ackType: string, ts: number): ArcEvent {
		const eventMs = ts || enrichedMsg.timestamp || Date.now();
		const eventSeconds = Math.floor(eventMs / 1000);
		return {
			source: "messenger",
			arcUserId: this.sessionId(),
			eventId: targetEventId,
			roomId: enrichedMsg.roomId,
			senderId: enrichedMsg.from,
			timestamp: eventMs,
			type: "receipt",
			encrypted: false,
			content: {
				ack: ackType,
				targetMessageId: targetEventId
			},
			relatesTo: {
				eventId: targetEventId
			},
			platform: "matrix",
			v: 1,
			ackPolicy: "at-least-once",
			ttlMs: 600000
		};
	}

	// Standardized RabbitMQ publishing (same as WhatsApp)
	private async publishEvent(ev: ArcEvent) {
		const rk = "ingress.messenger"; // Phase 2 unified ingress
		const ex = "arc.loop.ingress";
		const originLog = ev.origin ? ` origin=${ev.origin}` : "";
		const sigStr = ev.signature ? (typeof ev.signature === "string" ? ev.signature : JSON.stringify(ev.signature)) : "";
		const sigLog = sigStr ? ` signature=${sigStr}` : "";
		cli.printLog(`→ Publish ingress: ex=${ex} rk=${rk} type=${ev.type} arcUserId=${ev.arcUserId}${originLog}${sigLog}`);
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

		// Reply metadata (Matrix replies use m.relates_to -> m.in_reply_to.event_id)
		const relates = baseContent["m.relates_to"] || effectiveContent["m.relates_to"] || {};
		const replyEventId = relates?.["m.in_reply_to"]?.event_id || relates?.in_reply_to?.event_id || relates?.event_id || null;
		let replyTo: EnrichedMessage["replyTo"] | undefined;
		if (replyEventId) {
			try {
				const target = room.findEventById?.(replyEventId);
				if (target) {
					const maybeClient: any = matrixClient as any;
					try {
						if (typeof maybeClient.decryptEventIfNeeded === "function") {
							await maybeClient.decryptEventIfNeeded(target);
						}
					} catch {}
					const targetClear: any = (target as any).getClearContent?.() || target.getContent?.() || {};
					const targetBase: any = targetClear["m.new_content"] || targetClear;
					replyTo = {
						eventId: replyEventId,
						senderId: target.getSender?.() || undefined,
						body: targetBase?.body || targetBase?.formatted_body,
						timestamp: target.getTs?.()
					};
				} else {
					replyTo = { eventId: replyEventId };
				}
			} catch {
				replyTo = { eventId: replyEventId };
			}
		}

		await room.loadMembersIfNeeded();
		const myUserIdStr = (config.matrixUserId || "").trim();
		if (sender) await room.getMember(sender);
		await room.getMember(myUserIdStr); // Ensure my member is loaded

		let joined: any[] = []; // Initialize for log scope

		// Determine recipient "to" for legacy compatibility (user ID for DMs, room ID for groups)
		let toLegacy = matrixToLegacyId(roomId);
		let recipientId = sender === myUserIdStr ? room.guessDMUserId() || roomId : myUserIdStr;
		try {
			const myUserId = myUserIdStr;
			const myMembership = room.getMyMembership();
			const canonicalAlias = room.getCanonicalAlias();
			let isDm = canonicalAlias === null;
			let otherUserId: string | null = null;
			if (isDm) {
				const guessedDM = room.guessDMUserId();
				otherUserId = guessedDM && guessedDM !== myUserId ? guessedDM : null;
				if (sender === myUserId) {
					// Outgoing in a DM: recipient is the other member
					if (otherUserId) toLegacy = matrixToLegacyId(otherUserId);
				} else {
					// Incoming in a DM: recipient is us (my user id)
					toLegacy = matrixToLegacyId(myUserId);
				}
			} else {
				// Fallback to members check for groups with alias but 2 members
				joined = room.getMembersWithMembership?.("join") || room.getJoinedMembers?.() || room.getMembers?.() || [];
				const isDmFallback = joined.length === 2 && !!myUserId;
				if (isDmFallback) {
					otherUserId = joined.find((m: any) => m?.userId && m.userId !== myUserId)?.userId || null;
					if (otherUserId) {
						toLegacy = sender === myUserId ? matrixToLegacyId(otherUserId) : matrixToLegacyId(myUserId);
					}
				}
			}
			const joinedUsers = joined.map((m: any) => m?.userId || "unknown").join(", ");
			cli.printLog(
				`[translate] roomId=${roomId} sender=${sender} my=${myUserId} canonicalAlias=${canonicalAlias} myMembership=${myMembership} joined=${joined.length} users=[${joinedUsers}] isDm=${isDm} other=${otherUserId} recipient=${toLegacy} roomId=${roomId} recipientId=${recipientId}`
			);
		} catch (e) {
			cli.printLog(`[translate] DM check error: ${e}, fallback to roomId=${roomId} recipientId=${recipientId}`);
			// fallback keeps room-based recipient
		}

		return {
			id: { id: eventId, _serialized: eventId },
			from: matrixToLegacyId(sender),
			to: toLegacy,
			recipientId: recipientId,
			author: matrixToLegacyId(sender),
			type: this.getMessageType(effectiveContent?.msgtype || baseContent?.msgtype || "m.text"),
			body: effectiveContent?.body || effectiveContent?.formatted_body || baseContent?.body || "[No content]",
			timestamp: event.getTs(),
			serialId: eventId,
			roomId: roomId,
			...(replyTo ? { replyTo } : {}),
			...(effectiveContent.msgtype && ["m.image", "m.video", "m.audio", "m.file"].includes(effectiveContent.msgtype)
				? {
						media: {
							url: effectiveContent.url,
							info: effectiveContent.info || {}
						}
					}
				: {})
		};
	}

	// Phase 2: Canonical Messenger Event mapping
	private toCanonicalEventFromMessage(enriched: EnrichedMessage, encrypted: boolean, raw?: any): MessengerEvent {
		const contentBase = {
			body: enriched.body,
			msgtype: this.getMsgType(enriched.type)
		};
		return {
			source: "messenger",
			arcUserId: this.sessionId(),
			eventId: enriched.serialId,
			roomId: enriched.roomId,
			senderId: enriched.from,
			timestamp: enriched.timestamp,
			type: "message",
			encrypted,
			content: {
				...contentBase,
				...(enriched.replyTo ? { replyTo: enriched.replyTo } : {}),
				...(enriched.media ? { media: enriched.media } : {})
			},
			platform: "matrix"
		} as MessengerEvent;
	}

	private toCanonicalEventFromReaction(reaction: EnrichedReaction, roomId: string, senderId: string, ts: number): MessengerEvent {
		return {
			source: "messenger",
			arcUserId: this.sessionId(),
			eventId: reaction.id._serialized,
			roomId,
			senderId,
			timestamp: ts,
			type: "reaction",
			encrypted: false,
			content: {
				body: reaction.reaction,
				emoji: reaction.reaction,
				targetMessageId: reaction.msgId._serialized
			},
			relatesTo: { eventId: reaction.msgId._serialized, relationType: "annotation" },
			platform: "matrix"
		} as MessengerEvent;
	}

	private toCanonicalEventFromReceipt(
		targetEventId: string,
		roomId: string,
		reader: string,
		ts: number,
		ack: "read" | "received" = "read"
	): MessengerEvent {
		return {
			source: "messenger",
			arcUserId: this.sessionId(),
			roomId,
			senderId: reader,
			timestamp: ts,
			type: "receipt",
			encrypted: false,
			content: {
				ack,
				targetMessageId: targetEventId
			},
			relatesTo: { eventId: targetEventId },
			platform: "matrix"
		} as MessengerEvent;
	}

	private async resolveTargetEvent(matrixClient: MatrixClient, room: Room, eventId: string): Promise<MatrixEvent | null> {
		// 1) Try live timeline
		const fromTimeline = room.findEventById?.(eventId);
		if (fromTimeline) return fromTimeline;

		// 2) Try REST fetch
		try {
			const raw = await matrixClient.fetchRoomEvent(room.roomId, eventId);
			if (raw) {
				return new MatrixEvent(raw);
			}
		} catch (e) {
			cli.printLog(`[Reaction] fetchRoomEvent failed for ${eventId}: ${e}`);
		}

		// 3) Give up
		return null;
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

			const [contactsCollection, eventsCollection] = await this.database.getCollections(
				CollectionName.Contacts,
				CollectionName.Events
			);

			const enrichedMessage = await this.translateMatrixEvent(matrixClient, event, room);
			await this.addMatrixContact(matrixClient, enrichedMessage.from, contactsCollection);

			// Insert synthetic 'received' receipt for this message (store-only, no publish)
			try {
				const recv = this.toCanonicalEventFromReceipt(
					enrichedMessage.id._serialized,
					room.roomId,
					(config.matrixUserId || "").trim() || this.sessionId(),
					enrichedMessage.timestamp,
					"received"
				);
				await this.database.insertCanonicalEvent(recv, eventsCollection);
				cli.printLog(`[Receipt] Received (target: ${enrichedMessage.id._serialized}) id: n/a`);
			} catch (e) {
				this.logError("Synthetic receipt insert failed", e);
			}

			// Canonical storage: write message to events (placeholder if encrypted)
			const encrypted =
				event.getType() === "m.room.encrypted" ||
				(event as any).isDecryptionFailure?.() === true ||
				enrichedMessage.body === "[No content]";
			const cme = this.toCanonicalEventFromMessage(enrichedMessage, encrypted, event);
			await this.database.insertCanonicalEvent(cme, eventsCollection);

			// Publish to ARC ingress for central audit/routing
			const arcEvent = this.buildMessageEvent(enrichedMessage, encrypted);
			await this.publishEvent(arcEvent);

			// CLI print for message arrival
			try {
				const body = (enrichedMessage.body || "").toString();
				const trunc = body.length > 140 ? body.slice(0, 140) + "…" : body;
				cli.printLog(
					`Message received id: ${enrichedMessage.id._serialized} body: ${trunc || (encrypted ? "[encrypted]" : "[empty]")}`
				);
			} catch {}

			// If body was placeholder due to encryption, update the doc once decryption completes
			const anyEventUpdate: any = event as any;
			if (enrichedMessage.body === "[No content]" && anyEventUpdate && typeof anyEventUpdate.once === "function") {
				anyEventUpdate.once("Event.decrypted", async () => {
					try {
						const updated = await this.translateMatrixEvent(matrixClient, event, room);
						if (updated.body && updated.body !== "[No content]") {
							const cmeUpd = this.toCanonicalEventFromMessage(updated, false, event);
							await this.database.insertCanonicalEvent(cmeUpd, eventsCollection);
							cli.printLog(`🔓 Decrypted update for ${updated.id._serialized}: ${updated.body.substring(0, 50)}...`);
						}
					} catch (e) {
						this.logError("Deferred decrypt update error", e);
					}
				});
			}
		});
	}

	/**
	 * Handle message creation (our own messages)
	 */
	async handleMessageCreation(matrixClient: MatrixClient, event: MatrixEvent, room: Room): Promise<void> {
		await this.executeWithErrorLogging("Matrix Event Message Creation Error", async () => {
			const enrichedMessage = await this.translateMatrixEvent(matrixClient, event, room);
			const [contactsCollection, eventsCollection] = await this.database.getCollections(
				CollectionName.Contacts,
				CollectionName.Events
			);

			// Ensure both sides of the DM are recorded as contacts
			await this.addMatrixContact(matrixClient, enrichedMessage.to, contactsCollection);
			await this.addMatrixContact(matrixClient, enrichedMessage.from, contactsCollection);

			const cmeSelf = this.toCanonicalEventFromMessage(enrichedMessage, false, event);
			await this.database.insertCanonicalEvent(cmeSelf, eventsCollection);

			// Publish to ARC ingress for central audit/routing
			const arcEventSelf = this.buildMessageEvent(enrichedMessage, false);
			await this.publishEvent(arcEventSelf);

			// If body is not yet available (encrypted), schedule a deferred update after decryption
			const anyEventUpdate: any = event as any;
			if (enrichedMessage.body === "[No content]" && anyEventUpdate && typeof anyEventUpdate.once === "function") {
				anyEventUpdate.once("Event.decrypted", async () => {
					try {
						const updated = await this.translateMatrixEvent(matrixClient, event, room);
						if (updated.body && updated.body !== "[No content]") {
							const cmeUpd = this.toCanonicalEventFromMessage(updated, false, event);
							await this.database.insertCanonicalEvent(cmeUpd, eventsCollection);

							// Publish updated event if decrypted
							const arcEventUpd = this.buildMessageEvent(updated, false);
							await this.publishEvent(arcEventUpd);

							cli.printLog(`🔓 Decrypted update for ${updated.id._serialized}: ${updated.body.substring(0, 50)}...`);
						}
					} catch (e) {
						this.logError("Deferred decrypt update error", e);
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
			const [eventsCollection] = await this.database.getCollections(CollectionName.Events);

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

			await this.delay(this.DEFAULT_REACTION_DELAY);

			// Try to get the target message for enrichment
			let enrichedMessage: EnrichedMessage | null = null;
			const targetEvent = await this.resolveTargetEvent(matrixClient, room, targetEventId);
			if (targetEvent) {
				try {
					const maybeClient: any = matrixClient as any;
					if (typeof maybeClient.decryptEventIfNeeded === "function") {
						await maybeClient.decryptEventIfNeeded(targetEvent);
					}
				} catch {}
				enrichedMessage = await this.translateMatrixEvent(matrixClient, targetEvent, room);
			} else {
				// Fallback: try to enrich from stored canonical event
				try {
					const stored = await eventsCollection.findOne({ eventId: targetEventId });
					if (stored) {
						enrichedMessage = {
							id: { id: targetEventId, _serialized: targetEventId },
							from: stored.senderId || matrixToLegacyId(sender),
							to: stored.roomId || room.roomId,
							type: this.getMessageType(stored.content?.msgtype || "m.text"),
							body: stored.content?.body || "[unknown]",
							timestamp: stored.timestamp || Date.now(),
							serialId: targetEventId,
							roomId: stored.roomId || room.roomId
						};
					}
				} catch (e) {
					cli.printLog(`[Reaction] DB lookup for ${targetEventId} failed: ${e}`);
				}
			}

			// Always store a reaction record even if enrichment is partial
			const cme = this.toCanonicalEventFromReaction(enrichedReaction, room.roomId, sender, event.getTs());
			await this.database.insertCanonicalEvent(cme, eventsCollection);

			if (config.publishReactions && enrichedMessage) {
				const arcEvent = this.buildReactionEvent(enrichedReaction, enrichedMessage);
				await this.publishEvent(arcEvent);
			}
			cli.printLog(
				`[Reaction] Stored reaction ${emoji} from ${sender} on ${targetEventId} (publish ${
					config.publishReactions && enrichedMessage ? "yes" : "no/partial"
				})`
			);
		});
	}

	/**
	 * Handle Matrix read receipts (m.receipt) as ACK_READ upserts
	 */
	async handleIncomingReceipt(matrixClient: MatrixClient, event: MatrixEvent, room: Room): Promise<void> {
		await this.executeWithErrorLogging("Matrix Event Receipt Error", async () => {
			const [eventsCollection] = await this.database.getCollections(CollectionName.Events);

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
					const cme = this.toCanonicalEventFromReceipt(targetEventId, room.roomId, reader, ts);
					await this.database.insertCanonicalEvent(cme, eventsCollection);
					if (config.publishReceipts) {
						const arcReceipt = this.buildReceiptEvent(targetEventId, enrichedMessage, "ACK_READ", ts);
						await this.publishEvent(arcReceipt);
					}
					cli.printLog(
						`[Receipt] Stored read receipt from ${reader} for ${targetEventId} (publishing ${config.publishReceipts ? "enabled" : "disabled"})`
					);
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
