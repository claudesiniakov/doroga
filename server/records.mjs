import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

function json(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(body));
}

async function readSubmission(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size <= 1024) chunks.push(chunk);
  }
  if (size > 1024) return null;
  let value;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return null; }
  const nickname = typeof value?.nickname === 'string' ? value.nickname.trim() : '';
  const meters = value?.meters;
  const submission = value?.submission;
  return nickname.length > 0 && nickname.length <= 24 && !/[\u0000-\u001f\u007f]/u.test(nickname) &&
    Number.isSafeInteger(meters) && meters > 0 &&
    typeof submission === 'string' && /^[a-f0-9]{32}$/.test(submission)
    ? { nickname, meters, submission } : null;
}

export function openRecords(databasePath) {
  const database = new DatabaseSync(databasePath);
  database.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS records (
      id INTEGER PRIMARY KEY,
      submission TEXT NOT NULL UNIQUE,
      nickname TEXT NOT NULL,
      meters INTEGER NOT NULL CHECK (meters > 0)
    );
    CREATE INDEX IF NOT EXISTS records_ranking ON records (meters DESC, id ASC);
  `);

  const leaders = database.prepare('SELECT nickname, meters FROM records ORDER BY meters DESC, id ASC LIMIT 100');
  const insert = database.prepare('INSERT INTO records (submission, nickname, meters) VALUES (?, ?, ?) ON CONFLICT (submission) DO NOTHING');
  const bySubmission = database.prepare('SELECT id, nickname, meters FROM records WHERE submission = ?');
  const rank = database.prepare('SELECT count(*) + 1 AS place FROM records WHERE meters > ? OR (meters = ? AND id < ?)');

  const handle = async (request, response) => {
    if (request.url !== '/api/records') return json(response, 404, { error: 'not_found' });
    try {
      if (request.method === 'GET') return json(response, 200, leaders.all());
      if (request.method !== 'POST') {
        response.setHeader('Allow', 'GET, POST');
        return json(response, 405, { error: 'method_not_allowed' });
      }
      if (request.headers['content-type']?.split(';', 1)[0] !== 'application/json') {
        return json(response, 415, { error: 'expected_json' });
      }
      const entry = await readSubmission(request);
      if (!entry) return json(response, 400, { error: 'invalid_record' });
      const result = insert.run(entry.submission, entry.nickname, entry.meters);
      const stored = bySubmission.get(entry.submission);
      if (stored.nickname !== entry.nickname || stored.meters !== entry.meters) {
        return json(response, 409, { error: 'submission_conflict' });
      }
      return json(response, result.changes ? 201 : 200,
        rank.get(stored.meters, stored.meters, stored.id));
    } catch (error) {
      console.error(error);
      return json(response, 500, { error: 'server_error' });
    }
  };
  return { handle, close: () => database.close() };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const host = '127.0.0.1';
  const port = Number(process.env.DOROGA_RECORDS_PORT ?? 8094);
  const { handle } = openRecords(process.env.DOROGA_RECORDS_DB ?? '.doroga-records.sqlite');
  const server = createServer(handle);
  server.requestTimeout = 10000;
  server.listen(port, host, () => console.log(`Doroga records listening on ${host}:${port}`));
}
