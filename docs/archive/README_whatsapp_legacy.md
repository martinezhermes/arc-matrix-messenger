This document has been archived. It described the legacy WhatsApp Web service and Go/WhatsApp-era architecture. The current implementation is a Matrix-based Node.js/TypeScript messenger. See:

- docs/CURRENT_STATUS.md
- docs/PHASE2_PLAN.md
- docs/LOGGING.md
- docs/MATRIX_SAS_VERIFICATION.md

---

Original contents preserved below.

----

# ARC WhatsApp Project Documentation

## Overview
ARC WhatsApp is a headless Node.js server implementation of WhatsApp Web using Puppeteer. It functions as a bridge between WhatsApp Web and external systems through RabbitMQ messaging and MongoDB storage. The system:
- Runs WhatsApp Web in headless mode
- Listens for WhatsApp events (messages, reactions, etc.)
- Upserts event data into MongoDB
- Publishes enriched events to RabbitMQ topics
- Subscribes to egress topics for command execution
- Supports bootstrap mode for historical message fetching

## Architecture
```
WhatsApp Web Client
       │
       ├── (Events) → Event Handlers → MongoDB Storage
       │                   │
       │                   └──→ RabbitMQ (Ingress Topics)
       │
       └── RabbitMQ (Egress Topics) ← Command Processor
```

## Directory Structure

### Root Files
- **app.ts**: Core application class managing WhatsApp client lifecycle, event handlers, and system integrations
- **bootstrap.ts**: Entry point for historical message fetching (bootstrap mode)
- **config.ts**: Configuration management with environment variables
- **constants.ts**: WhatsApp-specific constants (status broadcast ID, etc.)
- **debug_fetch.ts**: Debug tool for fetching messages from specific contacts
- **index.ts**: Main application entry point (regular mode)
- **utils.ts**: Utility functions (date formatting, version fetching)

### cli/
- **ui.ts**: CLI interface implementation for logging, QR display, and user feedback

### handlers/
- **actions.ts**: Command execution handler (sends messages, reactions, etc.)
- **database.ts**: MongoDB connection and CRUD operations
- **events.ts**: WhatsApp event processing (messages, reactions, ACKs)
- **fetcher.ts**: Message fetching with batch processing and enrichment
- **mongo_store.ts**: Session storage implementation using MongoDB GridFS

### messaging/
- **egress.ts**: Egress message consumer (commands from RabbitMQ)
- **publisher.ts**: RabbitMQ message publisher
- **subscriber.ts**: RabbitMQ message subscriber

### types/
- **arc-event.ts**: Standardized event interface definition

## Component Details

### 1. Core Application (app.ts)
The `WhatsAppWebApp` class manages:
- WhatsApp client initialization with RemoteAuth
- RabbitMQ connection (publisher/subscriber)
- MongoDB connection
- Event handler registration
- Lifecycle management (start/shutdown)

Key modes:
- **Regular mode**: Normal operation listening for events
- **Bootstrap mode**: Historical message fetching
- **Debug fetch mode**: Targeted message inspection

### 2. Configuration System (config.ts)
Manages environment variables through `IConfig` interface:
```typescript
interface IConfig {
  appMessageBrokerUrl: string;    // RabbitMQ connection
  appDatabaseUri: string;         // MongoDB connection
  appUser: string;                // User identifier
  wid?: string;                   // WhatsApp JID
  collectionNamePrefix?: string;  // Session storage prefix
  // ...additional configuration
}
```

### 3. Event Processing (handlers/events.ts)
The `WhatsAppEventHandler` class:
- Processes incoming messages, reactions, and ACKs
- Enriches events with metadata
- Upserts to MongoDB
- Publishes standardized `ArcEvent` to RabbitMQ

Key event types:
- `MESSAGE_RECEIVED`: Incoming messages
- `MESSAGE_REACTION`: Message reactions
- `MESSAGE_ACK`: Message acknowledgments
- `MESSAGE_CREATE`: Outgoing messages

### 4. Data Storage (handlers/database.ts)
The `Database` class provides:
- MongoDB connection management
- Collection-specific operations:
  - `upsertMessage()`: Stores enriched messages
  - `upsertContact()`: Stores contact information
  - `upsertReaction()`: Stores message reactions
  - `upsertAck()`: Stores message acknowledgments

Collections used:
- `messages`: Message history
- `contacts`: Contact information
- `reactions`: Message reactions
- `acknowledgements`: Message delivery status

### 5. Session Management (handlers/mongo_store.ts)
Implements WhatsApp Web's RemoteAuth strategy using MongoDB GridFS:
- Stores session data as ZIP files in GridFS
- Handles session existence checks
- Manages session backup/restore
- Automatic session cleanup

### 6. Messaging System (messaging/)
#### Publisher (publisher.ts)
- Publishes events to RabbitMQ topics
- Standardized topic structure: `arc.loop.ingress`
- Routing key format: `ingress.whatsapp`

#### Subscriber (subscriber.ts)
- Subscribes to RabbitMQ topics
- Handles ARC command processing
- Manages queue bindings

#### Egress Consumer (egress.ts)
- Consumes commands from `arc.loop.egress`
- Routing key format: `egress.whatsapp.*`
- Routes commands to `WhatsAppActions`

### 7. Command Execution (handlers/actions.ts)
The `WhatsAppActions` class processes ARC commands:
- `sendMessage()`: Sends new messages
- `reactToMessage()`: Adds reactions
- `editMessage()`: Edits existing messages
- `sendSeenToChat()`: Marks chats as read
- `fetchMessagesFromContact()`: Historical message fetching

Command types:
- `message`: Send new message
- `reply`: Reply to message
- `react`: Add reaction
- `edit`: Edit message
- `seen`: Mark as seen
- `fetch_messages`: Historical fetch

### 8. Message Fetching (handlers/fetcher.ts)
The `Fetcher` class handles:
- Contact enrichment
- Message enrichment
- Batch message fetching
- Progress tracking
- Error handling and retries

Key methods:
- `fetchAllMessages()`: Full history fetch
- `fetchAllMessagesFromContact()`: Targeted contact fetch
- `newFetchAllMessages()`: Advanced fetch with progress tracking

## Data Flow

### Ingress Flow (WhatsApp → External Systems)
1. WhatsApp event occurs (message, reaction, etc.)
2. Event handler enriches data
3. Data upserted to MongoDB
4. Standardized `ArcEvent` published to RabbitMQ
5. External systems consume events from `arc.loop.ingress`

### Egress Flow (External Systems → WhatsApp)
1. Command published to `arc.loop.egress`
2. Egress consumer receives command
3. Command routed to appropriate action handler
4. WhatsApp client executes action
5. Result reflected in WhatsApp interface

## Standard Event Format
All events follow the `ArcEvent` interface:
```typescript
interface ArcEvent {
  _id?: string;
  origin: string;          // "whatsapp:{jid}"
  source: string;          // "whatsapp"
  signature: string;       // MongoDB signature
  sender: string;          // Source JID
  author: string;          // Message author
  recipient: string;       // Target JID
  content: any;            // Message content
  type: string;            // Event type
  appId: string;           // Application ID
  timestamp: number;       // Unix timestamp
  topic: string;           // Topic identifier
  v: number;               // Version
  ackPolicy: string;       // "at-least-once"
  ttlMs: number;           // Time-to-live
}
```

## Entry Points

### Regular Mode (index.ts)
Starts normal operation:
```bash
npm start
```

### Bootstrap Mode (bootstrap.ts)
Fetches historical messages:
```bash
npm run bootstrap
```

### Debug Fetch (debug_fetch.ts)
Fetches messages from specific contact:
```bash
npm run debug-fetch
```

## Configuration Requirements
Required environment variables:
```
APP_MESSAGE_BROKER_URL=rabbitmq://user:pass@host:port
APP_DATABASE_URI=mongodb://user:pass@host:port/db
APP_USER=your_whatsapp_number
APP_ID=unique_application_id
WID=whatsapp_jid (optional)
```

## Dependencies
- whatsapp-web.js: WhatsApp Web client library
- Puppeteer: Headless browser automation
- RabbitMQ: Message broker
- MongoDB: Data storage
- Mongoose: MongoDB ODM

## Matrix E2EE Verification

- SAS verification incident and stable pattern: [docs/MATRIX_SAS_VERIFICATION.md](./MATRIX_SAS_VERIFICATION.md)
- To allow automatic cross-signing/backup secret import during/after verification, set `MATRIX_RECOVERY_KEY_B64` to a 32-byte base64 value. If unset, the app runs in service mode and avoids SSSS prompts.

### Quick Troubleshooting

- If verification cancels before emojis: ensure no local verifier is created, accept the request once, and bind only to the SDK’s verifier. See the doc above for the stable pattern and logs to expect.

### Environment Example

```bash
# 32 raw bytes, base64-encoded
export MATRIX_RECOVERY_KEY_B64="BASE64_32_BYTE_VALUE"
```

