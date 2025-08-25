// Debug fetch entry point, similar structure to index.ts and bootstrap.ts

import { MatrixMessengerApp } from "./matrix-app";
import * as cli from "./cli/ui";

const TARGET_USER = "@user:matrix.org"; // Change to target Matrix user ID

const app = new MatrixMessengerApp(false);

app.startDebugFetch(TARGET_USER).catch((error) => {
	cli.printError(`Failed to run debug fetch: ${error.message}`);
	process.exit(1);
});

// Graceful shutdown handling
process.on("SIGINT", async () => {
	cli.print("Shutting down debug fetch gracefully...");
	await app.shutdown();
	process.exit(0);
});

process.on("SIGTERM", async () => {
	cli.print("Shutting down debug fetch gracefully...");
	await app.shutdown();
	process.exit(0);
});
