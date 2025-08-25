# ARC Matrix Messenger Migration Proposal

## Overview
This proposal outlines the migration from WhatsApp Web to Matrix messaging platform while maintaining 100% compatibility with the existing database, RabbitMQ messaging infrastructure, and all supporting components. The goal is a drop-in replacement of `WhatsAppWebApp` with `MatrixMessengerApp`.

## Executive Summary
Replace the WhatsApp client (`whatsapp-web.js` + Puppeteer) with Matrix client (`matrix-js-sdk`) while preserving:
- All existing database schemas and operations
- RabbitMQ messaging patterns (ingress/egress)
- Event handler architecture
- CLI interface and logging
- Bootstrap and debug modes
- Session management concepts

## Architecture Comparison

### Current WhatsApp Architecture
```
WhatsApp Web (Puppeteer) → Event Handlers → MongoDB Storage
                              │
                              └──→ RabbitMQ (Ingress Topics)
                              
RabbitMQ (Egress Topics) → Command Processor → WhatsApp Client
```

### Proposed Matrix Architecture
```
Matrix Client (SDK) → Event Handlers → MongoDB Storage
                         │
                         └──→ RabbitMQ (Ingress Topics)
                         
RabbitMQ (Egress Topics) → Command Processor → Matrix Client
```

## Core Changes Required

### 1. Application Class Replacement

**Current:** `WhatsAppWebApp` class
**New:** `MatrixMessengerApp` class

#### Key Methods Mapping:
| WhatsApp Method | Matrix Equivalent | Notes |
|----------------|-------------------|-------|
| `createClient()` | `createMatrixClient()` | Replace Puppeteer + RemoteAuth with Matrix SDK + device storage |
| `setupEventHandlers()` | `setupMatrixEventHandlers()` | Map WhatsApp events to Matrix events |
| `startDebugFetch()` | `startMatrixDebugFetch()` | Replace contact/message fetching logic |
| `initializeDatabase()` | *(unchanged)* | Keep existing MongoDB setup |

### 2. Event Mapping Strategy

#### Message Events
| WhatsApp Event | Matrix Event | Handler Method |
|---------------|--------------|----------------|
| `MESSAGE_RECEIVED` | `Room.timeline` | `handleIncomingMessage()` |
| `MESSAGE_CREATE` | `Room.timeline` (own messages) | `handleMessageCreation()` |
| `MESSAGE_ACK` | `Event.status` / receipts | `handleIncomingAck()` |
| `MESSAGE_REACTION` | `m.reaction` | `handleIncomingReaction()` |

#### Authentication Events
| WhatsApp Event | Matrix Event | Purpose |
|---------------|--------------|---------|
| `QR_RECEIVED` | *(N/A)* | Matrix uses device login flow |
| `AUTHENTICATED` | `sync` state | Client ready state |
| `READY` | `sync` PREPARED | Equivalent to WhatsApp ready |

### 3. ID/Address Translation

#### Identifier Mapping
| WhatsApp | Matrix | Format |
|----------|--------|---------|
| JID (`123456789@c.us`) | User ID (`@user:server.com`) | Matrix user ID |
| Group JID (`123-456@g.us`) | Room ID (`!roomid:server.com`) | Matrix room ID |
| Message ID | Event ID | Matrix event ID |

#### Database Compatibility Layer
Create translation functions to maintain existing database schemas:
```typescript
// Matrix ID → WhatsApp-style ID for database compatibility
function matrixToLegacyId(matrixId: string): string {
  // @user:matrix.org → user@matrix.org.c.us
  return matrixId.replace('@', '').replace(':', '@') + '.c.us';
}

function legacyToMatrixId(legacyId: string): string {
  // user@matrix.org.c.us → @user:matrix.org
  return '@' + legacyId.replace('.c.us', '').replace('@', ':');
}
```

### 4. Session Management

#### Current: MongoDB GridFS + RemoteAuth
```typescript
const store = new MongoStore({
  mongoose,
  collectionNamePrefix: this.collectionNamePrefix
});

new RemoteAuth({ store, backupSyncIntervalMs: 300000 })
```

#### Proposed: MongoDB + Matrix Device Storage
```typescript
const matrixStore = new MatrixMongoStore({
  mongoose,
  collectionNamePrefix: this.collectionNamePrefix.replace('Whatsapp', 'Matrix')
});

// Store access token, device ID, and sync state
```

### 5. Dependencies Update

#### Remove WhatsApp Dependencies
```json
{
  "remove": [
    "whatsapp-web.js",
    "puppeteer22",
    "wwebjs-mongo",
    "qrcode"
  ]
}
```

#### Add Matrix Dependencies
```json
{
  "add": [
    "matrix-js-sdk": "^29.1.0",
    "@matrix-org/matrix-sdk-crypto-nodejs": "^0.1.0"
  ]
}
```

## Implementation Plan

### Phase 1: Core Client Replacement
1. **Create `MatrixMessengerApp` class** - Replace `WhatsAppWebApp`
2. **Implement Matrix client initialization** - Replace Puppeteer setup
3. **Add Matrix authentication flow** - Replace QR code with device login
4. **Test basic connection** - Ensure Matrix client can connect and sync

### Phase 2: Event Handler Migration
1. **Update `MatrixEventHandler`** - Replace `WhatsAppEventHandler`
2. **Map Matrix events to existing event types** - Maintain compatibility
3. **Implement ID translation layer** - Preserve database schema
4. **Test event processing** - Ensure events flow to MongoDB/RabbitMQ

### Phase 3: Action Handler Migration
1. **Update `MatrixActions`** - Replace `WhatsAppActions`
2. **Implement command execution** - Send messages, reactions, etc.
3. **Test egress flow** - Ensure commands work from RabbitMQ
4. **Maintain command compatibility** - Same API for external systems

### Phase 4: Advanced Features
1. **Bootstrap mode** - Historical message fetching from Matrix
2. **Debug fetch mode** - Targeted room/user message inspection
3. **Session persistence** - Proper device storage management
4. **Error handling** - Matrix-specific error scenarios

## Detailed Component Changes

### 1. MatrixMessengerApp Class

```typescript
import { MatrixClient, createClient, RoomEvent, EventType } from 'matrix-js-sdk';

export class MatrixMessengerApp {
  private matrixClient: MatrixClient | null = null;
  private matrixARCReadyTimestamp: Date | null = null;
  
  // Keep all existing properties for database/messaging
  private mqSubscriber: RabbitMQSubscriber;
  private mqPublisher: RabbitMQPublisher;
  private database: Database;
  // ... other properties unchanged

  constructor(isBootstrap = false) {
    // Same constructor logic, just different client type
  }

  private async createMatrixClient(): Promise<MatrixClient> {
    const client = createClient({
      baseUrl: config.matrixHomeserver,
      accessToken: await this.getStoredAccessToken(),
      deviceId: await this.getStoredDeviceId(),
      userId: config.matrixUserId
    });

    // Configure crypto if needed
    await client.initCrypto();
    return client;
  }

  private setupMatrixEventHandlers(
    client: MatrixClient,
    fetcher: Fetcher,
    matrixActions: MatrixActions,
    matrixEventHandler: MatrixEventHandler
  ): void {
    // Map Matrix events to existing handler methods
    client.on(RoomEvent.Timeline, async (event, room, toStartOfTimeline) => {
      if (toStartOfTimeline) return;
      if (event.getType() === EventType.RoomMessage) {
        await matrixEventHandler.handleIncomingMessage(client, event);
      }
    });

    client.on('sync', (state, prevState, data) => {
      if (state === 'PREPARED') {
        // Equivalent to WhatsApp READY event
        this.matrixARCReadyTimestamp = new Date();
        cli.print(`Matrix client ready at ${formatDate(this.matrixARCReadyTimestamp)}`);
        
        // Start egress consumer
        const egress = new EgressConsumer(this.mqPublisher, matrixActions);
        egress.start().catch(err => cli.printError(`EgressConsumer start error: ${err?.message || err}`));
      }
    });

    // Handle reactions (m.reaction events)
    client.on(RoomEvent.Timeline, async (event, room) => {
      if (event.getType() === EventType.Reaction) {
        await matrixEventHandler.handleIncomingReaction(client, event);
      }
    });
  }
}
```

### 2. MatrixEventHandler Class

```typescript
export class MatrixEventHandler {
  // Keep same constructor and properties as WhatsAppEventHandler
  
  async handleIncomingMessage(matrixClient: MatrixClient, event: MatrixEvent) {
    await this.executeWithErrorLogging("Matrix Event Incoming Message Error", async () => {
      // Translate Matrix event to WhatsApp-compatible message structure
      const enrichedMessage = await this.translateMatrixMessage(event);
      
      // Use existing database operations (unchanged)
      const [msgCollection, contactsCollection] = await this.database.getCollections(
        CollectionName.Messages, 
        CollectionName.Contacts
      );
      
      await this.addMatrixContact(matrixClient, enrichedMessage.from, contactsCollection);
      await this.database.upsertMessage(enrichedMessage, msgCollection, "MESSAGE_RECEIVED");
      
      // Build and publish event (same format as WhatsApp)
      const arcEvent = this.buildMessageEvent(enrichedMessage);
      await this.publishEvent(arcEvent);
    });
  }

  private async translateMatrixMessage(event: MatrixEvent): Promise<EnrichedMessage> {
    const content = event.getContent();
    const sender = event.getSender();
    const room = event.getRoomId();
    
    return {
      id: { _serialized: event.getId() },
      from: matrixToLegacyId(sender), // Translate Matrix ID to legacy format
      to: matrixToLegacyId(room),
      author: matrixToLegacyId(sender),
      type: this.getMessageType(content.msgtype),
      body: content.body || '',
      timestamp: event.getTs(),
      serialId: event.getId()
    };
  }

  private buildMessageEvent(enriched: EnrichedMessage): ArcEvent {
    // Keep exact same format as WhatsApp implementation
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
}
```

### 3. MatrixActions Class

```typescript
export class MatrixActions {
  private client: MatrixClient;
  private fetcher: Fetcher;

  constructor(client: MatrixClient, fetcher: Fetcher) {
    this.client = client;
    this.fetcher = fetcher;
  }

  async sendMessageToJid(legacyJid: string, text: string): Promise<void> {
    // Translate legacy JID to Matrix room ID
    const roomId = legacyToMatrixId(legacyJid);
    
    await this.client.sendTextMessage(roomId, text);
  }

  async reactToMessage(messageId: string, emoji: string): Promise<void> {
    // Find the room and event, then send reaction
    const rooms = this.client.getRooms();
    for (const room of rooms) {
      const event = room.findEventById(messageId);
      if (event) {
        await this.client.sendEvent(room.roomId, EventType.Reaction, {
          "m.relates_to": {
            "rel_type": "m.annotation",
            "event_id": messageId,
            "key": emoji
          }
        });
        break;
      }
    }
  }

  // Implement other actions: editMessage, sendSeenToChat, etc.
}
```

### 4. Configuration Updates

```typescript
// Additional Matrix-specific config
export interface IConfig {
  // ... existing config properties ...
  
  // Matrix-specific
  matrixHomeserver: string;        // Matrix homeserver URL
  matrixUserId: string;           // Matrix user ID
  matrixAccessToken?: string;     // Stored access token
  matrixDeviceId?: string;        // Stored device ID
}

export const config: IConfig = Object.freeze({
  // ... existing config ...
  
  matrixHomeserver: process.env.MATRIX_HOMESERVER || "https://matrix.org",
  matrixUserId: process.env.MATRIX_USER_ID || "",
  matrixAccessToken: process.env.MATRIX_ACCESS_TOKEN,
  matrixDeviceId: process.env.MATRIX_DEVICE_ID
});
```

## Database Schema Compatibility

### Message Collection
```typescript
// Existing WhatsApp message document structure preserved
{
  _id: "matrix_event_id",
  from: "user@matrix.org.c.us",  // Translated Matrix ID
  to: "room@matrix.org.c.us",    // Translated room ID
  author: "user@matrix.org.c.us",
  type: "chat",
  body: "Message content",
  timestamp: 1640000000000,
  // ... other existing fields
}
```

### Contacts Collection
```typescript
// Existing contact structure preserved
{
  _id: "user@matrix.org.c.us",  // Translated Matrix user ID
  name: "Display Name",
  serialId: "user@matrix.org.c.us",
  // ... other existing fields
}
```

## Entry Points Compatibility

### Regular Mode (index.ts)
```typescript
import { MatrixMessengerApp } from './app';

const app = new MatrixMessengerApp(false);
app.start().catch(console.error);
```

### Bootstrap Mode (bootstrap.ts)
```typescript
import { MatrixMessengerApp } from './app';

const app = new MatrixMessengerApp(true);
app.start().catch(console.error);
```

### Debug Fetch (debug_fetch.ts)
```typescript
import { MatrixMessengerApp } from './app';

const targetUser = process.argv[2];
const app = new MatrixMessengerApp();
app.startDebugFetch(targetUser).catch(console.error);
```

## Migration Strategy

### 1. Gradual Replacement
- Keep WhatsApp code as `WhatsAppWebApp`
- Implement `MatrixMessengerApp` alongside
- Switch entry points to use Matrix version
- Remove WhatsApp code after testing

### 2. Configuration Migration
- Add Matrix environment variables
- Keep existing database/RabbitMQ configuration
- Update only the client-specific settings

### 3. Testing Strategy
- Unit tests for ID translation functions
- Integration tests for event processing
- End-to-end tests for command execution
- Performance tests for message throughput

## Risk Mitigation

### 1. Data Compatibility
- **Risk**: Database schema incompatibility
- **Mitigation**: ID translation layer maintains existing schema
- **Testing**: Comprehensive data migration tests

### 2. Event Processing
- **Risk**: Missing Matrix events
- **Mitigation**: Comprehensive event mapping documentation
- **Testing**: Event coverage analysis

### 3. Performance
- **Risk**: Matrix SDK performance differences
- **Mitigation**: Performance benchmarking and optimization
- **Testing**: Load testing with high message volumes

## Timeline Estimate

- **Phase 1**: 1-2 weeks (Core client replacement)
- **Phase 2**: 2-3 weeks (Event handler migration)
- **Phase 3**: 1-2 weeks (Action handler migration)  
- **Phase 4**: 2-3 weeks (Advanced features)
- **Total**: 6-10 weeks

## Success Criteria

1. **Drop-in Replacement**: Existing systems continue working without changes
2. **Data Compatibility**: All database operations remain functional
3. **Event Compatibility**: RabbitMQ consumers receive identical event format
4. **Command Compatibility**: External systems can send same commands
5. **Feature Parity**: All WhatsApp features work with Matrix equivalent

## Conclusion

This migration preserves the entire existing infrastructure while replacing only the messaging client. The translation layer ensures perfect compatibility with existing database schemas and RabbitMQ message formats, making this a true plug-and-play replacement.

The key innovation is the ID translation system that maps Matrix identifiers to WhatsApp-compatible formats, allowing all existing code (database operations, event processing, command handling) to work unchanged.
