import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getServiceForHandle, getChatTarget } from './db/messages.js';

const execFileP = promisify(execFile);

/**
 * Drive the Messages.app via AppleScript to send a single message to a
 * known handle (1:1 only). Requires:
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
 *
 * Group chats: this function CANNOT send to a group. AppleScript's
 * `buddy of service` form is per-recipient; groups are addressed by
 * `chat id <chat.guid>`. Use `sendToChat()` instead when you have a
 * chat_id — it auto-routes 1:1 vs group.
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

/**
 * Group-chat send — addresses by `chat id <chat.guid>` (the AppleScript
 * form Apple actually wants for groups). Internal helper; callers should
 * use `sendToChat()` which auto-routes 1:1 vs group.
 *
 * Note: AppleScript's `chat id` lookup is across all services on the
 * Messages.app side, so we don't need to scope to a service here.
 */
async function sendToGroupChatViaAppleScript(
  chatGuid: string,
  body: string,
): Promise<void> {
  const safeGuid = escapeAppleScriptString(chatGuid);
  const safeBody = escapeAppleScriptString(body);

  const script = `
on run
  tell application "Messages"
    set targetChat to a reference to chat id "${safeGuid}"
    send "${safeBody}" to targetChat
  end tell
end run
`.trim();

  await execFileP('osascript', ['-e', script]);
}

/**
 * Send a message into the right chat by chat.db chat_id. Single source
 * of truth for routing 1:1 vs group sends:
 *   - 1:1   → `buddy "<handle>" of <service>` (existing path)
 *   - group → `chat id "<chat.guid>"`         (group path)
 *
 * Throws if the chat_id doesn't exist in chat.db or has no resolvable
 * recipient (a 1:1 chat with no participants in chat_handle_join — which
 * shouldn't happen, but we surface the error rather than silently send
 * to nowhere).
 *
 * `opts.service` is only honored for 1:1 chats. Group sends use whatever
 * service the chat was created on (encoded in chat.guid).
 */
export async function sendToChat(
  chatId: number,
  body: string,
  opts: { service?: 'iMessage' | 'SMS' } = {},
): Promise<void> {
  const target = getChatTarget(chatId);
  if (!target) {
    throw new Error(`chat ${chatId} not found in chat.db`);
  }
  if (target.isGroup) {
    await sendToGroupChatViaAppleScript(target.chatGuid, body);
    return;
  }
  if (!target.handle) {
    throw new Error(`chat ${chatId} is 1:1 but has no resolvable handle`);
  }
  await sendMessageViaAppleScript(target.handle, body, opts);
}

function escapeAppleScriptString(s: string): string {
  // AppleScript double-quoted strings escape backslash and double quote.
  // Newlines need to be inserted as `" & return & "`.
  return s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r?\n/g, '" & return & "');
}
