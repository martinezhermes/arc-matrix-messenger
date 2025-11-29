import { MatrixMessengerApp } from "./matrix-app";
import * as cli from "./cli/ui";

// Create and start the application
const app = new MatrixMessengerApp(false); // false = regular mode

// Start the application
app.start().catch((error) => {
	cli.printError(`Failed to start Matrix application: ${error.message}`);
	process.exit(1);
});

let shuttingDown = false;
const handleShutdown = async () => {
	if (shuttingDown) return;
	shuttingDown = true;
	cli.print("Shutting down gracefully...");
	await app.shutdown();
	process.exit(0);
};

// Graceful shutdown handling
process.once("SIGINT", handleShutdown);
process.once("SIGTERM", handleShutdown);
