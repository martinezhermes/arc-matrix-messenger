// src/messaging/publisher.ts
import { connect, ChannelModel, Channel, Options, ConsumeMessage } from "amqplib";

class RabbitMQPublisher {
	private connection: ChannelModel | null = null;
	private channel: Channel | null = null;

	constructor(private uri: string) {}

	async connect(): Promise<void> {
this.connection = await connect(this.uri);
this.channel = await this.connection.createChannel();
// give the consumer some headroom
if (!this.channel) throw new Error("Cannot set prefetch, channel is not initialized.");
await this.channel.prefetch(16);
	}

	async publish(queueName: string, message: object): Promise<boolean> {
		if (!this.channel) throw new Error("Cannot publish message, channel is not initialized.");
		await this.channel.assertQueue(queueName, { durable: true });
		const buffer = Buffer.from(JSON.stringify(message));
		return this.channel.sendToQueue(queueName, buffer, { persistent: true, contentType: "application/json" });
	}

	async publishTopic(exchange: string, routingKey: string, body: any): Promise<void> {
		if (!this.channel) throw new Error("Cannot publish, channel is not initialized.");
		await this.channel.assertExchange(exchange, "topic", { durable: true });
		const buffer = Buffer.from(JSON.stringify(body));
		this.channel.publish(exchange, routingKey, buffer, { persistent: true, contentType: "application/json" });
	}

	// NEW: robust topic consumer with assert+bind+ack
	async consumeTopic(
		exchange: string,
		routingKey: string,
		queueName: string,
		onMessage: (msg: ConsumeMessage) => Promise<void> | void,
		opts: Options.Consume = {}
	): Promise<void> {
		if (!this.channel) throw new Error("Cannot consume, channel is not initialized.");

		await this.channel.assertExchange(exchange, "topic", { durable: true });

		// durable, non-exclusive queue per instance
		await this.channel.assertQueue(queueName, { durable: true, autoDelete: false });

		// ensure binding is present (safe if already exists)
		await this.channel.bindQueue(queueName, exchange, routingKey);

		await this.channel.consume(
			queueName,
			async (msg: ConsumeMessage | null) => {
				if (!msg) return;
				try {
					await onMessage(msg);
					this.channel!.ack(msg);
				} catch (e) {
					// basic nack w/ requeue=false to avoid poison loops (tune as needed)
					this.channel!.nack(msg, false, false);
				}
			},
			{ noAck: false, ...opts }
		);
	}

	async close(): Promise<void> {
		if (this.channel) await this.channel.close();
		if (this.connection) await this.connection.close();
	}
}

export default RabbitMQPublisher;
