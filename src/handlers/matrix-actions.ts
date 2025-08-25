import { MatrixClient, MatrixEvent, Room, EventType, Preset } from "matrix-js-sdk";
import * as cli from "../cli/ui";
import config from "../config";

/** IDs are canonical Matrix IDs now; no translation needed */
const toCanonical = (id: string) => id;

export class MatrixActions {
	private client: MatrixClient;
	
constructor(client: MatrixClient) {
this.client = client;
}

	/**
	 * Send a message to a Matrix room (equivalent to sendMessageToJid)
	 */
async sendMessageToJid(to: string, text: string): Promise<void> {
  try {
    let targetRoom: Room | null = null;

    if (to.startsWith("!")) {
      targetRoom = this.client.getRoom(to) || null;
      if (!targetRoom) {
        throw new Error(`Room ${to} not found`);
      }
    } else if (to.startsWith("@")) {
      targetRoom = await this.ensureDmRoom(to);
    } else {
      throw new Error(`Unsupported Matrix id: ${to}`);
    }

    await this.client.sendTextMessage(targetRoom.roomId, text);
    cli.printLog(`Message sent to ${targetRoom.name || targetRoom.roomId}: ${text}`);
  } catch (error) {
    cli.printError(`Failed to send message to ${to}: ${error}`);
    throw error;
  }
}

	/**
	 * React to a message (equivalent to reactToMessage)
	 */
	async reactToMessage(messageId: string, emoji: string): Promise<void> {
		try {
			// Find the room and event for this message ID
			const rooms = this.client.getRooms();
			let targetRoom: Room | null = null;
			let targetEvent: MatrixEvent | null = null;

			for (const room of rooms) {
				const event = room.findEventById(messageId);
				if (event) {
					targetRoom = room;
					targetEvent = event;
					break;
				}
			}

			if (!targetRoom || !targetEvent) {
				throw new Error(`Message ${messageId} not found in any room`);
			}

			await this.client.sendEvent(targetRoom.roomId, EventType.Reaction, {
				"m.relates_to": {
					rel_type: "m.annotation",
					event_id: messageId,
					key: emoji
				}
			});

			cli.printLog(`Reaction ${emoji} sent to message ${messageId}`);
		} catch (error) {
			cli.printError(`Failed to react to message ${messageId}: ${error}`);
			throw error;
		}
	}

	/**
	 * Edit a message (equivalent to editMessage)
	 */
	async editMessage(messageId: string, newText: string): Promise<void> {
		try {
			// Find the room and event for this message ID
			const rooms = this.client.getRooms();
			let targetRoom: Room | null = null;
			let targetEvent: MatrixEvent | null = null;

			for (const room of rooms) {
				const event = room.findEventById(messageId);
				if (event && event.getSender() === config.matrixUserId) {
					targetRoom = room;
					targetEvent = event;
					break;
				}
			}

			if (!targetRoom || !targetEvent) {
				throw new Error(`Message ${messageId} not found or not sent by current user`);
			}

			const originalContent = targetEvent.getContent();

			await this.client.sendEvent(targetRoom.roomId, EventType.RoomMessage, {
				msgtype: "m.text",
				body: `* ${newText}`,
				format: "org.matrix.custom.html",
				formatted_body: `* ${newText}`,
				"m.new_content": {
					msgtype: "m.text",
					body: newText
				},
				"m.relates_to": {
					rel_type: "m.replace",
					event_id: messageId
				}
			});

			cli.printLog(`Message ${messageId} edited to: ${newText}`);
		} catch (error) {
			cli.printError(`Failed to edit message ${messageId}: ${error}`);
			throw error;
		}
	}

	/**
	 * Mark a chat as read (equivalent to sendSeenToChat)
	 */
async sendSeenToChat(id: string): Promise<void> {
  try {
    let targetRoom: Room | null = null;

    if (id.startsWith("!")) {
      targetRoom = this.client.getRoom(id) || null;
    } else if (id.startsWith("@")) {
      targetRoom = this.findRoomByCanonical(id);
    }

    if (!targetRoom) {
      throw new Error(`Room not found for ${id}`);
    }

    const timeline = targetRoom.getLiveTimeline();
    const events = timeline.getEvents();
    const latestEvent = events[events.length - 1];

    if (latestEvent) {
      await this.client.sendReadReceipt(latestEvent);
      cli.printLog(`Read receipt sent for room ${targetRoom.name || targetRoom.roomId}`);
    }
  } catch (error) {
    cli.printError(`Failed to send read receipt for ${id}: ${error}`);
    throw error;
  }
}

	/**
	 * Fetch messages from a contact (equivalent to fetchMessagesFromContact)
	 */
async fetchMessagesFromContact(id: string, limit: number = 50): Promise<void> {
  try {
    let targetRoom: Room | null = null;

    if (id.startsWith("!")) {
      targetRoom = this.client.getRoom(id) || null;
    } else if (id.startsWith("@")) {
      targetRoom = this.findRoomByCanonical(id);
    }

    if (!targetRoom) {
      throw new Error(`Room not found for ${id}`);
    }

    await this.client.scrollback(targetRoom, limit);
    cli.printLog(`Fetched messages from room ${targetRoom.name || targetRoom.roomId}`);
  } catch (error) {
    cli.printError(`Failed to fetch messages from ${id}: ${error}`);
    throw error;
  }
}

/**
 * Get room by canonical Matrix ID (@user:... or !room:...)
 */
private findRoomByCanonical(id: string): Room | null {
  if (id.startsWith("!")) {
    return this.client.getRoom(id) || null;
  }
  if (id.startsWith("@")) {
    const rooms = this.client.getRooms();
    for (const room of rooms) {
      const members = room.getMembers();
      if (members.length === 2) {
        const other = members.find((m) => m.userId !== config.matrixUserId);
        if (other && other.userId === id) return room;
      }
    }
  }
  return null;
}

/**
 * Ensure a DM room exists with the target user; create if missing
 */
private async ensureDmRoom(targetUserId: string): Promise<Room> {
  const existing = this.findRoomByCanonical(targetUserId);
  if (existing) return existing;

  cli.printLog(`Creating new direct message room with ${targetUserId}`);
  const { room_id } = await this.client.createRoom({
    invite: [targetUserId],
    is_direct: true,
    preset: Preset.PrivateChat
  });
  const room = this.client.getRoom(room_id);
  if (!room) throw new Error(`DM room creation failed for ${targetUserId}`);
  return room;
}

/**
 * Set typing state (m.typing)
 */
async setTyping(id: string, isTyping: boolean, timeoutMs = 30000): Promise<void> {
try {
  let targetRoom: Room | null = null;
  if (id.startsWith("!")) {
    targetRoom = this.client.getRoom(id) || null;
  } else if (id.startsWith("@")) {
    targetRoom = this.findRoomByCanonical(id);
  }
  if (!targetRoom) throw new Error(`Room not found for ${id}`);

  await this.client.sendTyping(targetRoom.roomId, isTyping, isTyping ? timeoutMs : 0);
  cli.printLog(`Typing ${isTyping ? "started" : "stopped"} in ${targetRoom.name || targetRoom.roomId}`);
} catch (error) {
  cli.printError(`Failed to set typing in ${id}: ${error}`);
  throw error;
}
}

/**
 * Redact a message by event ID
 */
async redactMessage(messageId: string, reason?: string): Promise<void> {
try {
  const rooms = this.client.getRooms();
  for (const room of rooms) {
    const ev = room.findEventById(messageId);
    if (ev) {
      await this.client.redactEvent(room.roomId, messageId, undefined, reason ? { reason } : undefined);
      cli.printLog(`Message ${messageId} redacted${reason ? `: ${reason}` : ""}`);
      return;
    }
  }
  throw new Error(`Message ${messageId} not found`);
} catch (error) {
  cli.printError(`Failed to redact message ${messageId}: ${error}`);
  throw error;
}
}

/**
 * Reply to a message by event ID
 */
async replyToMessage(messageId: string, replyContent: string): Promise<void> {
		try {
			// Find the room containing the target event
			const rooms = this.client.getRooms();
			let targetRoom: Room | null = null;

			for (const room of rooms) {
				const ev = room.findEventById(messageId);
				if (ev) {
					targetRoom = room;
					break;
				}
			}

			if (!targetRoom) {
				throw new Error(`Message ${messageId} not found in any room`);
			}

			await this.client.sendEvent(targetRoom.roomId, EventType.RoomMessage, {
				msgtype: "m.text",
				body: replyContent,
				"m.relates_to": {
					"m.in_reply_to": { event_id: messageId }
				}
			});

			cli.printLog(`Reply sent to message ${messageId}`);
		} catch (error) {
			cli.printError(`Failed to reply to message ${messageId}: ${error}`);
			throw error;
		}
	}

	private _extractMessageContent(content: any): string {
		return typeof content === "string" ? content : content?.message || content?.text || JSON.stringify(content);
	}

	/**
	 * Handle ARC egress action (Matrix)
	 */
	async handleARCEvent(event: any): Promise<void> {
		const { command, to, content, emoji, new_content } = event || {};
		cli.printLog(`Handling ARC instruction: ${command}`);
		cli.printLog(`Event data: ${JSON.stringify(event)}`);

const handlers: Record<string, () => Promise<void>> = {
  message: async () => {
    const text = this._extractMessageContent(content);
    await this.sendMessageToJid(to, text);
  },
  reply: async () => {
    const text = this._extractMessageContent(content);
    await this.replyToMessage(to, text);
  },
  react: async () => {
    if (!emoji) throw new Error("No emoji provided for reaction");
    await this.reactToMessage(to, emoji);
  },
  edit: async () => {
    if (!new_content) throw new Error("No new content provided for edit");
    await this.editMessage(to, new_content);
  },
  seen: async () => {
    await this.sendSeenToChat(to);
  },
  typing: async () => {
    const stateRaw = content?.state;
    const isTyping =
      typeof stateRaw === "boolean" ? stateRaw : /^(on|start|true|1)$/i.test(String(stateRaw));
    const timeoutMs = content?.timeoutMs ?? 30000;
    await this.setTyping(to, isTyping, timeoutMs);
  },
  redact: async () => {
    const reason = content?.reason;
    await this.redactMessage(to, reason);
  },
  fetch_messages: async () => {
    const legacyId = content?.contact_id || to;
    const limit = content?.limit ?? 50;
    await this.fetchMessagesFromContact(legacyId, limit);
  },
  no_action: async () => {
    cli.printLog(`End of command: ${JSON.stringify(event)}`);
  }
};

		const handler = handlers[String(command)] || null;
		if (handler) {
			await handler();
		} else {
			cli.printError(`Unknown command type: ${command}`);
		}
	}

	/**
	 * Get available rooms (for debugging)
	 */
	getRooms(): Room[] {
		return this.client.getRooms();
	}

	/**
	 * Get room information by legacy JID
	 */
getRoomInfo(id: string): any {
  const room = this.findRoomByCanonical(id);
  if (!room) {
    return null;
  }

  return {
    roomId: room.roomId,
    name: room.name,
    members: room.getMembers().map((member) => ({
      userId: member.userId,
      displayName: member.name,
      legacyId: member.userId
    })),
    legacyId: room.roomId
  };
}
}
