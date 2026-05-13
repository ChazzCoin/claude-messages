import { initializeApp, getApps } from 'firebase-admin/app';
import { getDatabase } from 'firebase-admin/database';
import { applicationDefault } from 'firebase-admin/app';

async function run() {
  const app = getApps().length ? getApps()[0] : initializeApp({ credential: applicationDefault(), databaseURL: 'https://galt-messages.firebaseio.com/' });
  const db = getDatabase(app);
  const snap = await db.ref('/repos/2').get();
  const val = snap.val();
  const prs = val?.open_prs;
  console.log('open_prs type:', typeof prs, Array.isArray(prs) ? 'IS JS array' : 'NOT JS array');
  console.log('open_prs keys:', prs ? Object.keys(prs) : 'null');
  console.log('open_pr_count from snap:', val?.open_pr_count);
  process.exit(0);
}
run().catch(console.error);
