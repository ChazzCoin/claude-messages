import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getServiceForHandle } from './db/messages.js';

const execFileP = promisify(execFile);

/**
 * Drive the Messages.app via AppleScript to send a single message.
 * Requires:
 *   - Messages.app running and signed in
 *   - Automation permission granted (System Settings → Privacy & Security
 *     → Automation → Terminal/your runner → Messages enabled)
 *
 * iMessage (blue-bubble) is reliable. SMS fallback (green-bubble) works
 * when iMessage is unavailable for the recipient but is flakier.
 *
 * When `service` is not passed, looks up the recipient's most-recent
 * message in chat.db and uses whatever service Apple actually used —
 * so Android/RCS contacts go out as SMS instead of failing as iMessage.
 *
 * Never call this without explicit user approval — drafts go through
 * the approval queue first.
 */
export async function sendMessageViaAppleScript(
  recipient: string,
  body: string,
  opts: { service?: 'iMessage' | 'SMS' } = {},
): Promise<void> {
  const service = opts.service ?? getServiceForHandle(recipient) ?? 'iMessage';
  const safeRecipient = escapeAppleScriptString(recipient);
  const safeBody = escapeAppleScriptString(body);

  const script = `
on run
  tell application "Messages"
    set targetService to 1st service whose service type = ${service}
    set targetBuddy to buddy "${safeRecipient}" of targetService
    send "${safeBody}" to targetBuddy
  end tell
end run
`.trim();

  await execFileP('osascript', ['-e', script]);
}

function escapeAppleScriptString(s: string): string {
  // AppleScript double-quoted strings escape backslash and double quote.
  // Newlines need to be inserted as `" & return & "`.
  return s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r?\n/g, '" & return & "');
}
