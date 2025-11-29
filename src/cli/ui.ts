import color from "picocolors";
import config from "../config";

const ANSI_RE = /\x1B\[[0-9;]*m/g;
function hasVisibleDiamond(s: string): boolean {
  try {
    const visible = String(s || "").replace(ANSI_RE, "");
    return /^\s*◇/.test(visible);
  } catch {
    return false;
  }
}
function stripVisibleDiamond(s: string): string {
  try {
    const visible = String(s || "").replace(ANSI_RE, "");
    return visible.replace(/^\s*◇\s*/, "");
  } catch {
    return s;
  }
}

 // Read version from package.json
const { version } = require("../../package.json");

// Log level gating
const LEVELS = { silent: 0, error: 10, warn: 20, info: 30, debug: 40 } as const;
type Level = keyof typeof LEVELS;
function isEnabled(level: Level): boolean {
  const current = (config.logLevel as Level) || "info";
  return LEVELS[level] <= LEVELS[current];
}

export const print = (text: string) => {
  if (!isEnabled("info")) return;
  const body = hasVisibleDiamond(text) ? stripVisibleDiamond(text) : text;
  console.log(color.green("◇") + "  " + body);
};

export const printLog = (text: string) => {
  if (!isEnabled("debug")) return;
  const body = hasVisibleDiamond(text) ? stripVisibleDiamond(text) : text;
  console.log(color.blue("◇") + "  " + body);
};

export const printError = (text: string) => {
  if (!isEnabled("error")) return;
  const body = hasVisibleDiamond(text) ? stripVisibleDiamond(text) : text;
  console.log(color.red("◇") + "  " + body);
};

export const printWarning = (text: string) => {
  if (!isEnabled("warn")) return;
  const body = hasVisibleDiamond(text) ? stripVisibleDiamond(text) : text;
  console.log(color.yellow("◇") + "  " + body);
};

export const printIntro = () => {
if (!isEnabled("info")) return;
console.log("");
console.log(color.bgCyan(color.white(` R&I ARC Matrix Messenger v${version} `)));
console.log("|----------------------------------------------------------------------------|");
console.log("|      A Matrix client that handles Matrix events using an R&I ARC API.      |");
console.log("|----------------------------------------------------------------------------|");
};

export const printBootstrap = () => {
if (!isEnabled("info")) return;
console.log("");
console.log(color.bgCyan(color.white(` R&I ARC Matrix Messenger Bootstrap v${version} `)));
console.log("|------------------------------------------------------------|");
console.log("| Bootstraping ARC database for contacts and messages.       |");
console.log("|------------------------------------------------------------|");
};

export const printQRCode = (qr: string) => {
if (!isEnabled("info")) return;
console.log(qr);
console.log(color.green("◇") + "  " + "Scan the QR code above to login into Matrix.");
};

export const printLoading = () => {
if (!isEnabled("info")) return;
console.log(color.green("◇") + "  " + `Logging in into Matrix servers as ${config.appUser}...`);
};

export const printAuthenticated = () => {
if (!isEnabled("info")) return;
console.log(color.green("◇") + "  " + "Authenticated.");
};

export const printAuthenticationFailure = () => {
if (!isEnabled("error")) return;
console.log(color.red("◇") + "  " + "Authentication failed!");
};

export const printOutro = () => {
if (!isEnabled("info")) return;
console.log(color.green("◇") + "  " + "ARC Matrix Messenger is ready.");
};
