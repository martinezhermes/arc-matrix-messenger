// Imports
import { Database, CollectionName } from "./database";
import { Fetcher } from "./fetcher";
import { Message, Client, Events } from "whatsapp-web.js";
import RabbitMQPublisher from "../messaging/publisher";
import * as cli from "../cli/ui";
import config from "../config";
import { ArcEvent } from "../types/arc-event";

// use client info to get the user wid etc!
// client.clientInfo.wid

// Types and Constants
interface GlobalContext {
	origin: string;
	signature: string;
	sender: string;
	author: string;
	recipient: string;
	type: EventTypes;
	appId: string;
	timestamp: number;
	// Use unknown to enforce type safety and require explicit type checks.
	content: unknown;
}

// For some reason, the whatsapp-web lib generates the callback
// for the message_reaction but forgets to add it to the Events enum.
// We add it here to ensure we can handle it properly.
export enum MissingEvents {
	MESSAGE_REACTION = "message_reaction"
}

type EventTypes = Events | MissingEvents;

interface EnrichedAck {
	messageId: string;
	senderId: string;
	targetId: string;
	authorId: string | null;
	ackValue: number;
	ackType: string;
	timestamp: number;
	messageType: string;
	body: string;
}

interface EnrichedMessage {
	id: { _serialized: string } | string;
	from: string;
	to: string;
	author?: string;
	participant?: string;
	ack?: number;
	type: string;
	body: string;
	timestamp: number;
	t?: number;
	serialId?: string;
}

interface EnrichedContact {
	name?: string;
	serialId?: string;
}

interface Reaction {
	msgId: { _serialized: string };
	[key: string]: unknown;
}

// Main Event Handler Class
export class WhatsAppEventHandler {
	private publisher: RabbitMQPublisher;
	private fetcher: Fetcher;
	private database: Database;

	// Delay helper (parameterized)
	private readonly DEFAULT_ACK_DELAY = 2000;
	private readonly DEFAULT_REACTION_DELAY = 1000;

	private readonly ACK_TYPES = ["ACK_ERROR", "ACK_PENDING", "ACK_SERVER", "ACK_DEVICE", "ACK_READ", "ACK_PLAYED"];

	constructor(publisher: RabbitMQPublisher, fetcher: Fetcher, database: Database) {
		this.publisher = publisher;
		this.fetcher = fetcher;
		this.database = database;
	}

	// Canonical helpers
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
			origin: `whatsapp:${enriched.from}`,
			source: "whatsapp",
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

	private buildReactionEvent(reaction: any, enrichedMsg: EnrichedMessage): ArcEvent {
		return {
			_id: reaction.msgId._serialized, // Use msgId as unique identifier
			origin: `whatsapp:${enrichedMsg.from}`,
			source: "whatsapp",
			signature: this.signatureFor(config.primaryDbMessages, "reactions"),
			sender: enrichedMsg.from,
			author: enrichedMsg.author || enrichedMsg.from,
			recipient: enrichedMsg.to,
			content: { emoji: (reaction as any).reaction, targetMessageId: reaction.msgId._serialized },
			type: "reaction",
			appId: config.appId,
			timestamp: reaction.timestamp || enrichedMsg.timestamp,
			topic: "_",
			v: 1,
			ackPolicy: "at-least-once",
			ttlMs: 600000
		};
	}

	// Standardized RabbitMQ publishing
	private async publishEvent(ev: ArcEvent) {
		const rk = "ingress.whatsapp";
		const ex = "arc.loop.ingress";
		const sigStr = typeof ev.signature === "string" ? ev.signature : JSON.stringify(ev.signature);
		cli.printLog(`→ Publish ingress: ex=${ex} rk=${rk} type=${ev.type} appId=${ev.appId} origin=${ev.origin} signature=${sigStr}`);
		await this.publisher.publishTopic(ex, rk, ev);
	}

	// ACK Handler
	async handleIncomingAck(whatsappClient: Client, message: Message, ack: number) {
		await this.executeWithErrorLogging("WhatsApp Event ACK Error", async () => {
			const [ackCollection] = await this.database.getCollections(CollectionName.Acknowledgements);
			const event = Events.MESSAGE_ACK;

			await this.delay(this.DEFAULT_ACK_DELAY);

			const msg = await whatsappClient.getMessageById(message.id._serialized);
			const supportEnrichedMessage = await this.fetcher.enrichMessage(msg);
			const ackDoc = this.buildEnrichedAck(message, supportEnrichedMessage, ack);
			await this.database.upsertAck(ackDoc, ackCollection, event);
		});
	}

	// Message Creation Handler
	async handleMessageCreation(whatsappClient: Client, message: Message) {
		await this.executeWithErrorLogging("WhatsApp Event Message Creation Error", async () => {
			const enrichedMessage: EnrichedMessage = await this.fetcher.enrichMessage(message);
			const [messageCollection] = await this.database.getCollections(CollectionName.Messages);
			const event = Events.MESSAGE_CREATE;

			await this.database.upsertMessage(enrichedMessage, messageCollection, event);
		});
	}

	// Incoming Message Handler
	async handleIncomingMessage(whatsappClient: Client, message: Message) {
		await this.executeWithErrorLogging("WhatsApp Event Incoming Message Error", async () => {
			const [msgCollection, contactsCollection] = await this.database.getCollections(
				CollectionName.Messages,
				CollectionName.Contacts
			);
			const event = Events.MESSAGE_RECEIVED;

			const enrichedMessage: EnrichedMessage = await this.fetcher.enrichMessage(message);
			await this.addContact(whatsappClient, enrichedMessage.from, contactsCollection);
			await this.database.upsertMessage(enrichedMessage, msgCollection, event);
			const ev = this.buildMessageEvent(enrichedMessage);
			await this.publishEvent(ev);
		});
	}

	private async addContact(whatsappClient: Client, contactId: string, contactsCollection: any) {
		this.executeWithErrorLogging(`Failed to fetch/upsert contact for ${contactId}`, async () => {
			const contact = await whatsappClient.getContactById(contactId);
			if (contact) {
				const enrichedContact: EnrichedContact = await this.fetcher.enrichContact(contact);
				await this.database.upsertContact(enrichedContact, contactsCollection);
				cli.printLog(`Contact upserted: ${enrichedContact.name || enrichedContact.serialId}`);
			}
		});
	}

	// Reaction Handler
	async handleIncomingReaction(whatsappClient: Client, reaction: any) {
		await this.executeWithErrorLogging("WhatsApp Event Reaction Error", async () => {
			const [reactionCollection, msgCollection] = await this.database.getCollections(
				CollectionName.Reactions,
				CollectionName.Messages
			);
			const event = MissingEvents.MESSAGE_REACTION;

			await this.database.upsertReaction(reaction, reactionCollection);
			await this.delay(this.DEFAULT_REACTION_DELAY);

			const enrichedMessage = await this.fetcher.enrichMessage(await whatsappClient.getMessageById(reaction.msgId._serialized));
			await this.database.upsertMessage(enrichedMessage, msgCollection, event);
			const ev = this.buildReactionEvent(reaction, enrichedMessage);
			await this.publishEvent(ev);
		});
	}

	// Delay utility
	private delay(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}

	private buildEnrichedAck(message: Message, enriched: EnrichedMessage, ack: number): EnrichedAck {
		const ackValue = typeof ack === "number" ? ack : (enriched.ack ?? 0);
		const ackType = this.ACK_TYPES[ackValue] || "UNKNOWN";
		return {
			messageId: message.id._serialized,
			senderId: enriched.from,
			targetId: enriched.to,
			authorId: enriched.author || enriched.participant || null,
			ackValue,
			ackType,
			timestamp: enriched.t || enriched.timestamp,
			messageType: enriched.type,
			body: enriched.body
		};
	}

	// Removed: getEnrichedMessage, now handled inline with Fetcher class.

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
