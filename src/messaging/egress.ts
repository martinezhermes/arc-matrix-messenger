import RabbitMQPublisher from "./publisher";
import config from "../config";
import * as cli from "../cli/ui";
import { MatrixActions } from "../handlers/matrix-actions";

const EX_EGRESS = "arc.loop.egress";

/**
 * EgressConsumer
 * - Binds a durable queue to arc.loop.egress with rk=egress.matrix.#
 * - Consumes egress actions and delivers them to Matrix targets
 * - Uses the existing RabbitMQPublisher connection/channel (sink only; no publish)
 */
export class EgressConsumer {
	constructor(
		private publisher: RabbitMQPublisher,
		private actions: MatrixActions
	) {}

// src/messaging/egress-consumer.ts (your EgressConsumer)
async start(): Promise<void> {
const wid = config.wid || config.matrixUserId || config.appId || "default";
const safeWid = String(wid).replace(/[^A-Za-z0-9._-]/g, "_");
const rkPrimary = "egress.messenger.#";
const qname = `messenger.egress.${safeWid}`;

cli.print(`Binding messenger egress: ex=${EX_EGRESS} rk=${rkPrimary} q=${qname}`);

const handler = async (msg: any) => {
const rkIn = (msg.fields as any)?.routingKey || "";
cli.print(`Egress received: rk=${rkIn} bytes=${msg.content.length}`);

const raw = msg.content.toString("utf-8");
let body: any;
try {
body = JSON.parse(raw);
} catch (e) {
cli.printError(`Egress JSON parse error: ${e}`);
return;
}

if (body?.action) {
const arcEvent = { ...body.action, command: body.action.action_type };
await this.actions.handleARCEvent(arcEvent as any);
cli.print(`Egress action handled: ${body.action.action_type}`);
} else {
cli.printError(`WARN egress: missing action in payload`);
}
};

// Bind primary messenger topic
await this.publisher.consumeTopic(EX_EGRESS, rkPrimary, qname, handler);

// Backward-compat bindings
const rkCompatMatrix = "egress.matrix.#";
cli.print(`Binding messenger egress (compat-matrix): ex=${EX_EGRESS} rk=${rkCompatMatrix} q=${qname}`);
await this.publisher.consumeTopic(EX_EGRESS, rkCompatMatrix, qname, handler);

const rkCompatWhatsApp = "egress.whatsapp.#";
cli.print(`Binding messenger egress (compat-whatsapp): ex=${EX_EGRESS} rk=${rkCompatWhatsApp} q=${qname}`);
await this.publisher.consumeTopic(EX_EGRESS, rkCompatWhatsApp, qname, handler);
  
// Add binding for Matrix user ID pattern (e.g., egress.@ach9.endurance.network)
const matrixUserId = config.matrixUserId;
if (matrixUserId) {
  // Remove @ and : from Matrix ID to create routing key pattern
  const userBase = matrixUserId.replace(/:/g, '.');
  const patterns = [
    `egress.${userBase}`,
    `egress.messenger.${userBase}`
  ];
  for (const p of patterns) {
    cli.print(`Binding messenger egress (user): ex=${EX_EGRESS} rk=${p} q=${qname}`);
    await this.publisher.consumeTopic(EX_EGRESS, p, qname, handler);
  }
}

cli.print(`Egress consumer is listening on queue ${qname}`);
}
}
