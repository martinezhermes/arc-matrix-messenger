import { WhatsAppEventHandler, MissingEvents } from "./handlers/events";
import { Client, Message, Events, RemoteAuth } from "whatsapp-web.js";
import { formatDate, fetchLatestWwebVersion } from "./utils";
import { Fetcher, FetchOptions } from "./handlers/fetcher";
import RabbitMQSubscriber from "./messaging/subscriber";
import RabbitMQPublisher from "./messaging/publisher";
import { EgressConsumer } from "./messaging/egress";
import { WhatsAppActions } from "./handlers/actions";
import { MongoStore } from "./handlers/mongo_store";
import { Database } from "./handlers/database";
import constants from "./constants";
import mongoose from "mongoose";
import * as cli from "./cli/ui";
import config from "./config";
import qrcode from "qrcode";

export class WhatsAppWebApp {
	private whatsappARCReadyTimestamp: Date | null = null;
	private mqSubscriber: RabbitMQSubscriber;
	private mqPublisher: RabbitMQPublisher;
	private client: Client | null = null;
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
		this.collectionNamePrefix = config.collectionNamePrefix || this.appUser.toLowerCase() + "WhatsappSession";

		// Only instantiate messaging components in non-bootstrap mode
		this.mqSubscriber = new RabbitMQSubscriber(this.appMessageBrokerUrl);
		this.mqPublisher = new RabbitMQPublisher(this.appMessageBrokerUrl);
		this.database = new Database();
	}

	/**
	 * Start the WhatsApp application in debug fetch mode
	 */
	async startDebugFetch(targetContact: string): Promise<void> {
		try {
			cli.printIntro();
			await this.initializeDatabase();

			// No MQ needed for debug fetch
			// Create client
			this.client = await this.createClient();
			const client = this.client as Client;

			cli.printLoading();

			client.on(Events.QR_RECEIVED, (qr: string) => {
				qrcode.toString(qr, { type: "terminal", small: true }, (err, url) => {
					if (err) throw err;
					cli.printQRCode(url);
				});
			});

			client.on(Events.AUTHENTICATED, () => cli.printAuthenticated());
			client.on(Events.AUTHENTICATION_FAILURE, () => cli.printAuthenticationFailure());

			client.on(Events.READY, async () => {
				cli.print("WhatsApp connected! Starting debug fetch...");

				try {
					const chat = await client.getChatById(`${targetContact}@c.us`);
					if (!chat) {
						cli.printError(`Chat not found with ${targetContact}`);
						process.exit(1);
					}

					await new Promise((resolve) => setTimeout(resolve, 2000));
					const messages = await chat.fetchMessages({ limit: 4 });

					cli.print(`Found ${messages.length} messages`);

					if (messages.length > 0) {
						messages.forEach((msg, index) => {
							const timestamp = new Date(msg.timestamp * 1000).toISOString();
							const from = msg.fromMe ? "Me" : "Hermes";
							cli.print(`[${index}] [${timestamp}] ${from}: ${msg.body}`);
						});
					} else {
						cli.print("No messages found.");
					}
				} catch (error) {
					cli.printError(`Debug fetch failed: ${error}`);
				}

				cli.print("Debug fetch completed.");
				process.exit(0);
			});

			client.initialize();
		} catch (error) {
			this.handleError(error);
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
		this.database.connect();

		await mongoose.connect(this.authenticationDatabaseUri, {
			serverSelectionTimeoutMS: 5000,
			retryWrites: true
		});

		cli.print("Connected to ARC DB.");
	}

	/**
	 * Create and configure the WhatsApp client
	 */
	private async createClient(): Promise<Client> {
		const wwebVersion = await fetchLatestWwebVersion();

		const webVersionCache = {
			type: "remote" as const,
			remotePath: `https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/${wwebVersion}.html`
		};

		cli.print(`Web Version Cache: ${JSON.stringify(webVersionCache)}`);
		cli.print(`Debug URL: ${webVersionCache.remotePath}`);

		const store = new MongoStore({
			mongoose,
			collectionNamePrefix: this.collectionNamePrefix
		});

		return new Client({
			puppeteer: {
				args: ["--no-sandbox", "--disable-setuid-sandbox"]
			},
			authStrategy: new RemoteAuth({
				store: store,
				backupSyncIntervalMs: 300000
			}),
			webVersionCache: webVersionCache
		});
	}

	/**
	 * Initialize dependencies (handlers, publishers, etc.)
	 */
	private initializeDependencies(client: Client): {
		fetcher: Fetcher;
		whatsappActions: WhatsAppActions;
		whatsappEventHandler: WhatsAppEventHandler;
	} {
		const fetcherInstance = new Fetcher(client, this.database);
		const whatsappEventHandler = new WhatsAppEventHandler(this.mqPublisher, fetcherInstance, this.database);
		const whatsappActions = new WhatsAppActions(client, fetcherInstance);

		return { fetcher: fetcherInstance, whatsappActions, whatsappEventHandler };
	}

	/**
	 * Set up all event handlers for the WhatsApp client
	 */
	private setupEventHandlers(
		client: Client,
		fetcher: Fetcher,
		whatsappActions: WhatsAppActions,
		whatsappEventHandler: WhatsAppEventHandler,
		fetchOptions?: FetchOptions
	): void {
		// QR Code event
		client.on(Events.QR_RECEIVED, (qr: string) => {
			qrcode.toString(
				qr,
				{
					type: "terminal",
					small: true,
					margin: 2,
					scale: 1
				},
				(err, url) => {
					if (err) throw err;
					cli.printQRCode(url);
				}
			);
		});

		// Authentication events
		client.on(Events.AUTHENTICATED, () => {
			cli.printAuthenticated();
		});

		client.on(Events.AUTHENTICATION_FAILURE, () => {
			cli.printAuthenticationFailure();
		});

		// Ready event
		client.on(Events.READY, () => {
			const egress = new EgressConsumer(this.mqPublisher, whatsappActions);
			egress.start().catch((err) => cli.printError(`EgressConsumer start error: ${err?.message || err}`));

			this.whatsappARCReadyTimestamp = new Date();
			client.sendPresenceUnavailable();
			cli.print(`${this.appUser} was last seen ${formatDate(this.whatsappARCReadyTimestamp)}.`);
			cli.printOutro();

			// Bootstrap-specific logic: fetch messages with progress tracking
			if (this.isBootstrapMode) {
				this.startMessageFetching(fetcher, fetchOptions);
			}
		});

		// Message events
		client.on(Events.MESSAGE_RECEIVED, async (message: Message) => {
			if (message.from === constants.statusBroadcast) return;
			await whatsappEventHandler.handleIncomingMessage(client, message);
		});

		client.on(MissingEvents.MESSAGE_REACTION, async (reaction) => {
			// Normalize senderId and config.appId for comparison
			const normalizeId = (id: string) => id.replace(/:.*(?=@c\.us)/, "");
			if (normalizeId(reaction.senderId) === normalizeId(config.appId)) return;
			cli.print(`Rection sender: ${reaction.senderId}, config appId: ${config.appId}`);
			await whatsappEventHandler.handleIncomingReaction(client, reaction);
		});

		client.on(Events.MESSAGE_ACK, async (message, ack) => {
			// await whatsappEventHandler.handleIncomingAck(this.client, message, ack);
		});

		client.on(Events.MESSAGE_CREATE, async (message: Message) => {
			if (message.from === constants.statusBroadcast || !message.fromMe) return;
			await whatsappEventHandler.handleMessageCreation(this.client!, message);
		});

		// Session events
		client.on(Events.REMOTE_SESSION_SAVED, () => {
			cli.print("Remote session has been successfully saved.");
		});
	}

	/**
	 * Start message fetching for bootstrap mode
	 */
	private async startMessageFetching(fetcher: Fetcher, fetchOptions?: FetchOptions, maxMessages = Infinity): Promise<void> {
		try {
			await fetcher.newFetchAllMessages(maxMessages, fetchOptions);
		} catch (error: any) {
			cli.printError(`Failed to fetch messages: ${error.message}`);
		}
	}

	/**
	 * Start the WhatsApp application
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
			this.client = await this.createClient();

			// Initialize dependencies
			const { fetcher, whatsappActions, whatsappEventHandler } = this.initializeDependencies(this.client);

			// Setup event handlers
			this.setupEventHandlers(this.client!, fetcher, whatsappActions, whatsappEventHandler, messageFetchOptions);

			cli.printLoading();

			// Initialize WhatsApp Client
			this.client.initialize();
		} catch (error) {
			this.handleError(error);
		}
	}

	// Internal function moved from subscriber
	async startARCSubscriber(client: Client, eventHandler: (client: Client, event: any) => Promise<void>): Promise<void> {
		if (!this.mqSubscriber) {
			cli.printError("MQ Subscriber not initialized - cannot start ARC subscriber");
			return;
		}

		try {
			const queueName = "whatsapp_arc_commands";
			await this.mqSubscriber.subscribe(queueName, async (channel: any, message: any) => {
				if (message !== null) {
					const arcEvent = JSON.parse(message.content.toString());
					try {
						await eventHandler(arcEvent, client);
						channel.ack(message);
					} catch (error) {
						console.error("Error handling ARC event:", error);
						channel.nack(message);
					}
				}
			});
			cli.print(`Subscribed to ARC channel: ${queueName}`);
			cli.print("ARC WhatsApp subscribed to ARC Events. Listening for incoming events.");
		} catch (error) {
			cli.printError(`Error starting ARC subscriber: ${error}`);
		}
	}

	// Subscribe to Central egress to receive actions for WhatsApp
	async startEgressSubscriber(whatsappActions: WhatsAppActions): Promise<void> {
		try {
			const exchange = "arc.loop.egress";
			const binding = "egress.whatsapp.*";
			// Bind to egress for all WhatsApp jids
			const q = await this.mqSubscriber.bindTopic(exchange, binding, "whatsapp.egress");

			await this.mqSubscriber.consume(q, async (message) => {
				try {
					const ev = JSON.parse(message.content.toString());
					if (!ev?.origin || typeof ev.origin !== "string" || !ev.origin.startsWith("whatsapp:")) {
						return;
					}
					const jid = ev.origin.split(":")[1];
					const type = String(ev.type || "");

					if (type.startsWith("action.message")) {
						const text = ev?.content?.text ?? ev?.content?.body ?? "";
						await whatsappActions.sendMessageToJid(jid, text);
					} else if (type.startsWith("action.react")) {
						cli.printLog(`Egress react action received for ${jid} (not implemented in MVP).`);
					} else {
						// Ignore other types for MVP
					}
				} catch (err) {
					cli.printError(`Error handling egress event: ${err}`);
				}
			});

			cli.print(`Subscribed to egress: ${exchange} with ${binding}`);
		} catch (error) {
			cli.printError(`Error starting egress subscriber: ${error}`);
		}
	}

	/**
	 * Handle application errors
	 */
	private handleError(error: any): void {
		if (error.name === "MongoServerError" && error.code === 18) {
			cli.printError("Authentication failed - please check your database credentials");
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
			await this.client.destroy();
		}

		// Only close messaging components if they were initialized
		await this.mqPublisher.close();
		await this.mqSubscriber.close();
		await this.database.disconnect();
		await mongoose.disconnect();
	}
}
