import 'dotenv/config';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const home = os.homedir();
const projectRoot = path.resolve(import.meta.dirname, '..');

function int(v: string | undefined, fallback: number): number {
  const n = v ? parseInt(v, 10) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

const dataDir = path.join(projectRoot, 'data');
fs.mkdirSync(dataDir, { recursive: true });

export const config = {
  host: process.env.HOST || '127.0.0.1',
  port: int(process.env.PORT, 3000),

  projectRoot,
  webDir: path.join(projectRoot, 'web'),
  dataDir,

  chatDbPath: process.env.CHAT_DB_PATH || path.join(home, 'Library', 'Messages', 'chat.db'),
  appDbPath: process.env.APP_DB_PATH || path.join(dataDir, 'app.db'),

  openai: {
    apiKey: process.env.OPENAI_API_KEY || '',
    model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
  },

  firebase: {
    mirrorEnabled: process.env.FIREBASE_MIRROR_ENABLED !== 'false',
    databaseUrl: process.env.FIREBASE_DB_URL || 'https://galt-messages.firebaseio.com/',
    includeMessageText: process.env.FIREBASE_MIRROR_INCLUDE_MESSAGE_TEXT === 'true',
  },
} as const;
