import { Client, MessageEditOptions } from "whatsapp-web.js";
import * as cli from "../cli/ui";
import { Fetcher } from "./fetcher";

interface ARCEvent {
	command: string;
	to: string;
	content: any;
	emoji?: string;
	new_content?: string;
	origin?: string;
	target_id?: string;
}

interface FetchMessagesEvent {
	content: {
		contact_id: string;
		limit: number;
	};
	target_id: string;
}

class WhatsAppActions {
	private client: Client;
	private fetcher: Fetcher;

	constructor(client: Client, fetcher: Fetcher) {
		this.client = client;
		this.fetcher = fetcher;
	}

	async sendMessage(messageId: string, messageContent: string, options?: { quotedMessageId?: string }): Promise<void> {
		try {
			const message = await this.client.getMessageById(messageId);
			await this.client.sendMessage(message.to, messageContent);
			cli.printLog(`Message sent to ${message.to}`);
		} catch (error) {
			cli.printError(`Error sending message: ${error}`);
		}
	}

	async sendMessageToTarget(targetId: string, messageContent: string): Promise<void> {
		try {
			await this.client.sendMessage(targetId, messageContent);
			cli.printLog(`Message sent to ${targetId}`);
		} catch (error) {
			cli.printError(`Error sending message to ${targetId}: ${error}`);
		}
	}

	// Minimal helper for Central egress actions
	async sendMessageToJid(jid: string, text: string): Promise<void> {
		try {
			const chat = await this.client.getChatById(jid);
			await chat.sendMessage(text);
			cli.printLog(`Egress message sent to ${jid}`);
		} catch (error) {
			cli.printError(`Error sending egress message to ${jid}: ${error}`);
		}
	}

	async reactToMessage(messageId: string, emoji: string, chatId?: string): Promise<void> {
		const resolvedId = await this._resolveMessageId(messageId, chatId);
		if (!resolvedId) return;

		try {
			const message = await this.client.getMessageById(resolvedId);
			if (!message) {
				cli.printError(`Message not found (tried serialized: ${resolvedId})`);
				return;
			}
			await message.react(emoji);
			cli.printLog(`Reaction "${emoji}" sent to message ${resolvedId}`);
		} catch (error) {
			cli.printError(`Failed to react to message: ${error} (tried serialized: ${resolvedId})`);
		}
	}

	async replyToMessage(messageId: string, replyContent: string, chatId?: string): Promise<void> {
		const resolvedId = await this._resolveMessageId(messageId, chatId);
		if (!resolvedId) return;

		try {
			const originalMessage = await this.client.getMessageById(resolvedId);
			if (!originalMessage) {
				cli.printError("Original message not found");
				return;
			}

			await originalMessage.reply(replyContent);
			cli.printLog(`Reply sent to message ${resolvedId} in chat ${originalMessage.from}`);
		} catch (error) {
			cli.printError(`Error sending reply to message ${messageId}: ${error}`);
		}
	}

	async editMessage(messageId: string, newContent: string, options?: MessageEditOptions): Promise<void> {
		try {
			const message = await this.client.getMessageById(messageId);
			const editedMessage = await message.edit(newContent, options);

			if (editedMessage) {
				cli.printLog(`Message edited to: ${editedMessage.body}`);
			} else {
				cli.printError("Failed to edit the message.");
			}
		} catch (error) {
			cli.printError(`Error editing message: ${error}`);
		}
	}

	async sendSeenToChat(chatId: string): Promise<void> {
		try {
			const chat = await this.client.getChatById(chatId);
			if (!chat) {
				cli.printError(`Chat not found for chatId: ${chatId}`);
				return;
			}
			await chat.sendSeen();
			await this.client.sendSeen(chat.id._serialized);
			cli.printLog(`Marked chat ${chatId} as seen`);
		} catch (error) {
			cli.printError(`Error marking chat ${chatId} as seen: ${error}`);
		}
	}

	async fetchMessagesFromContact(event: FetchMessagesEvent): Promise<void> {
		const { contact_id, limit } = event.content;
		const targetId = event.target_id;
		cli.printLog(`Fetching messages from contact: ${contact_id} with limit: ${limit}`);

		try {
			await this.fetcher.fetchAllMessagesFromContact(this.client, contact_id, limit);
			cli.printLog(`Messages from contact ${contact_id} fetched successfully`);
			await this.sendMessageToTarget(targetId, `Successfully fetched ${limit} messages from contact ${contact_id}.`);
		} catch (error) {
			cli.printError(`Error fetching messages from contact ${contact_id}: ${error}`);
			await this.sendMessageToTarget(targetId, `Failed to fetch messages from contact ${contact_id}. Please try again later.`);
		}
	}

	async handleARCEvent(event: ARCEvent): Promise<void> {
		const { command, to, content, emoji, new_content } = event;
		cli.printLog(`Handling ARC instruction: ${command}`);
		cli.printLog(`Event data: ${JSON.stringify(event)}`);

		const handlers = {
			message: () => this._handleSendMessage(to, content),
			reply: () => this._handleSendReply(to, content),
			react: () => this._handleSendReact(to, emoji),
			edit: () => this._handleSendEdit(to, new_content),
			seen: () => this._handleSendSeen(to),
			fetch_messages: () => this._handleFetchMessages(event as any),
			no_action: () => this._handleNoAction(event)
		};

		const handler = handlers[command as keyof typeof handlers];
		if (handler) {
			await handler();
		} else {
			cli.printError(`Unknown command type: ${command}`);
		}
	}

	private async _resolveMessageId(messageId: string, chatId?: string): Promise<string | null> {
		if (!chatId) return messageId;

		try {
			const chat = await this.client.getChatById(chatId);
			if (!chat || typeof chat.fetchMessages !== "function") {
				cli.printError(`Chat not found or fetchMessages not available for chatId: ${chatId}`);
				return null;
			}

			const messages = await chat.fetchMessages({ limit: 50 });
			const found = messages.find((msg) => msg.id.id === messageId || msg.id._serialized === messageId);
			return found ? found.id._serialized : null;
		} catch (error) {
			cli.printError(`Error resolving serialized message id: ${error}`);
			return null;
		}
	}

	private _extractMessageContent(content: any): string {
		return typeof content === "string" ? content : content?.message || content;
	}

	private async _handleSendMessage(to: string, content: any): Promise<void> {
		const messageContent = this._extractMessageContent(content);
		await this.sendMessageToTarget(to, messageContent);
	}

	private async _handleSendReply(to: string, content: any): Promise<void> {
		const replyContent = this._extractMessageContent(content);
		await this.replyToMessage(to, replyContent);
	}

	private async _handleSendReact(to: string, emoji?: string): Promise<void> {
		if (!emoji) {
			cli.printError("No emoji provided for reaction");
			return;
		}
		await this.reactToMessage(to, emoji);
	}

	private async _handleSendEdit(to: string, newContent?: string): Promise<void> {
		if (!newContent) {
			cli.printError("No new content provided for edit");
			return;
		}
		await this.editMessage(to, newContent);
	}

	private async _handleSendSeen(to: string): Promise<void> {
		await this.sendSeenToChat(to);
	}

	private async _handleFetchMessages(event: FetchMessagesEvent): Promise<void> {
		await this.fetchMessagesFromContact(event);
	}

	private _handleNoAction(event: ARCEvent): void {
		cli.printLog(`End of command: ${JSON.stringify(event)}`);
	}
}

export { WhatsAppActions, ARCEvent };
