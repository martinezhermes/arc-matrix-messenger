import axios from "axios";

const startsWithIgnoreCase = (str: string, prefix: string): boolean =>
  str.toLowerCase().startsWith(prefix.toLowerCase());
function formatDate(lastSeenTimestamp: number | Date): string {
	const now = new Date();
	const lastSeenDate = new Date(lastSeenTimestamp);

	const isToday = now.toDateString() === lastSeenDate.toDateString();
	const isYesterday = new Date(now.setDate(now.getDate() - 1)).toDateString() === lastSeenDate.toDateString();

	const timeString = lastSeenDate.toLocaleTimeString(undefined, {
		hour: "2-digit",
		minute: "2-digit",
		timeZone: "GMT",
		hour12: false
	});

	if (isToday) {
		return `today at ${timeString}`;
	} else if (isYesterday) {
		return `yesterday at ${timeString}`;
	} else {
		return `${lastSeenDate.toLocaleDateString()} at ${timeString}`;
	}
}

async function fetchLatestWwebVersion(): Promise<string> {
	try {
		const response = await axios.get("https://raw.githubusercontent.com/wppconnect-team/wa-version/main/versions.json");
		return response.data.currentVersion;
	} catch (error) {
		console.error(`Failed to fetch the latest WhatsApp Web version: ${error}`);
		throw error;
	}
}

export { formatDate, startsWithIgnoreCase, fetchLatestWwebVersion };
