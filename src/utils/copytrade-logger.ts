import { appendFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";

const LOG_DIR = join(process.cwd(), "logs");
const LOG_FILE = join(LOG_DIR, "copytrade-errors.log");

/**
 * Ensures the logs directory exists
 */
async function ensureLogDir(): Promise<void> {
  if (!existsSync(LOG_DIR)) {
    await mkdir(LOG_DIR, { recursive: true });
  }
}

/**
 * Formats a timestamp for log entries
 */
function getTimestamp(): string {
  return new Date().toISOString();
}

/**
 * Formats an error object for logging
 */
function formatError(error: any): string {
  if (error instanceof Error) {
    return `${error.message}\n${error.stack || ""}`;
  }
  return String(error);
}

/**
 * Logs an error related to copytrade operations
 */
export async function logCopytradeError(
  context: string,
  error: any,
  additionalInfo?: Record<string, any>
): Promise<void> {
  try {
    await ensureLogDir();

    const timestamp = getTimestamp();
    const errorMessage = formatError(error);
    const info = additionalInfo ? JSON.stringify(additionalInfo, null, 2) : "";

    const logEntry = `
[${timestamp}] ERROR in ${context}
${errorMessage}
${info ? `Additional Info:\n${info}` : ""}
${"=".repeat(80)}
`;

    await appendFile(LOG_FILE, logEntry, "utf-8");
  } catch (logError) {
    // Fallback to console if file logging fails
    console.error(`❌ Failed to write to error log file:`, logError);
    console.error(`Original error in ${context}:`, error);
  }
}

/**
 * Logs a warning related to copytrade operations
 */
export async function logCopytradeWarning(
  context: string,
  message: string,
  additionalInfo?: Record<string, any>
): Promise<void> {
  try {
    await ensureLogDir();

    const timestamp = getTimestamp();
    const info = additionalInfo ? JSON.stringify(additionalInfo, null, 2) : "";

    const logEntry = `
[${timestamp}] WARNING in ${context}
${message}
${info ? `Additional Info:\n${info}` : ""}
${"=".repeat(80)}
`;

    await appendFile(LOG_FILE, logEntry, "utf-8");
  } catch (logError) {
    // Fallback to console if file logging fails
    console.warn(`⚠️  Failed to write to error log file:`, logError);
    console.warn(`Original warning in ${context}:`, message);
  }
}

