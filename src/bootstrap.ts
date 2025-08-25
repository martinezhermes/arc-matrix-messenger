import { MatrixMessengerApp } from "./matrix-app";
import * as cli from "./cli/ui";
import type { FetchProgress } from "./handlers/fetcher";

// Create and start the application in bootstrap mode
const app = new MatrixMessengerApp(true); // true = bootstrap mode

// Start the application with custom message fetching options
app.start({
	batchSize: 100,
	maxRetries: 3,
	maxConcurrentBatches: 2,
	checkpointInterval: 5,
	onProgress: (progress: FetchProgress) => {
		const elapsedMinutes = (new Date().getTime() - progress.startTime.getTime()) / 1000 / 60;
		const contactsPerMinute = progress.processedContacts / elapsedMinutes;
		const messagesPerMinute = progress.processedMessages / elapsedMinutes;

		cli.print(
			`Progress: ${progress.processedContacts}/${progress.totalContacts} contacts ` +
				`(${contactsPerMinute.toFixed(2)}/min), ` +
				`${progress.processedMessages} messages (${messagesPerMinute.toFixed(2)}/min)`
		);
	}
}).catch((error) => {
	cli.printError(`Failed to start Matrix bootstrap: ${error.message}`);
	process.exit(1);
});

// Graceful shutdown handling
process.on("SIGINT", async () => {
	cli.print("Shutting down bootstrap gracefully...");
	await app.shutdown();
	process.exit(0);
});

process.on("SIGTERM", async () => {
	cli.print("Shutting down bootstrap gracefully...");
	await app.shutdown();
	process.exit(0);
});
