import { connect, ChannelModel, Channel, ConsumeMessage } from "amqplib";

class RabbitMQSubscriber {
	private connection: ChannelModel | null = null;
	private channel: Channel | null = null;

	constructor(private uri: string) {}

	public async connect(): Promise<void> {
		this.connection = await connect(this.uri);
		this.channel = await this.connection.createChannel();
	}

	public async subscribe(queueName: string, onMessage: (channel: Channel, message: ConsumeMessage | null) => void): Promise<void> {
		if (!this.channel) {
			throw new Error("Cannot subscribe to messages, channel is not initialized.");
		}

		await this.channel.assertQueue(queueName, { durable: true });
		this.channel.consume(queueName, (message: ConsumeMessage | null) => onMessage(this.channel!, message));
	}

	// New: bind to a topic exchange with a binding key; optional named queue
	public async bindTopic(exchange: string, bindingKey: string, queueName?: string): Promise<string> {
		if (!this.channel) {
			throw new Error("Cannot bind topic, channel is not initialized.");
		}
		await this.channel.assertExchange(exchange, "topic", { durable: true });
		const q = await this.channel.assertQueue(queueName || "", { durable: true });
		await this.channel.bindQueue(q.queue, exchange, bindingKey);
		return q.queue;
	}

	// New: generic consume helper with ack/nack handling
	public async consume(queueName: string, handler: (message: ConsumeMessage, ch: Channel) => Promise<void>): Promise<void> {
		if (!this.channel) {
			throw new Error("Cannot consume, channel is not initialized.");
		}
		await this.channel.consume(queueName, async (message: ConsumeMessage | null) => {
			if (!message) return;
			try {
				await handler(message, this.channel!);
				this.channel!.ack(message);
			} catch (_e) {
				// Dead-letter by not requeueing
				this.channel!.nack(message, false, false);
			}
		});
	}

	public async close(): Promise<void> {
		if (this.channel) {
			await this.channel.close();
		}
		if (this.connection) {
			await this.connection.close();
		}
	}
}

export default RabbitMQSubscriber;
