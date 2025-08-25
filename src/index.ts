import { MatrixMessengerApp } from "./matrix-app";
import * as cli from "./cli/ui";

// Create and start the application
const app = new MatrixMessengerApp(false); // false = regular mode

// Start the application
app.start().catch((error) => {
	cli.printError(`Failed to start Matrix application: ${error.message}`);
	process.exit(1);
});

// Graceful shutdown handling
process.on("SIGINT", async () => {
	cli.print("Shutting down gracefully...");
	await app.shutdown();
	process.exit(0);
});

process.on("SIGTERM", async () => {
	cli.print("Shutting down gracefully...");
	await app.shutdown();
	process.exit(0);
});
