import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

function json(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(body));
}

// 220 км/ч с ускоренным въездом на пост ДПС (×1,7) и округлением пробега.
const MAX_METERS_PER_SECOND = 105;
const RUN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

async function readJson(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size <= 1024) chunks.push(chunk);
  }
  if (size > 1024) return null;
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return null; }
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
    CREATE TABLE IF NOT EXISTS record_runs (
      token TEXT PRIMARY KEY,
      started_at INTEGER NOT NULL,
      meters INTEGER CHECK (meters > 0)
    );
    CREATE INDEX IF NOT EXISTS record_runs_age ON record_runs (started_at);
    CREATE INDEX IF NOT EXISTS records_ranking ON records (meters DESC, id ASC);
  `);

  const createRun = database.prepare('INSERT INTO record_runs (token, started_at) VALUES (?, ?)');
  const pruneRuns = database.prepare('DELETE FROM record_runs WHERE started_at < ?');
  const findRun = database.prepare('SELECT started_at, meters FROM record_runs WHERE token = ?');
  const finishRun = database.prepare('UPDATE record_runs SET meters = ? WHERE token = ? AND meters IS NULL');
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
      const entry = await readJson(request);
      const now = Date.now();
      if (entry?.action === 'start') {
        const run = randomUUID().replaceAll('-', '');
        pruneRuns.run(now - RUN_TTL_MS);
        createRun.run(run, now);
        return json(response, 201, { run });
      }
      const run = entry?.run;
      if (typeof run !== 'string' || !/^[a-f0-9]{32}$/.test(run)) {
        return json(response, 400, { error: 'invalid_run' });
      }
      const started = findRun.get(run);
      if (!started || started.started_at < now - RUN_TTL_MS) {
        return json(response, 404, { error: 'run_not_found' });
      }
      if (entry.action === 'finish') {
        const meters = entry.meters;
        if (started.meters !== null) {
          return started.meters === meters
            ? json(response, 200, {})
            : json(response, 409, { error: 'run_already_finished' });
        }
        const maxMeters = Math.ceil((now - started.started_at) * MAX_METERS_PER_SECOND / 1000) + 1;
        if (!Number.isSafeInteger(meters) || meters <= 0 || meters > maxMeters) {
          return json(response, 400, { error: 'invalid_distance' });
        }
        finishRun.run(meters, run);
        return json(response, 200, {});
      }

      const nickname = typeof entry.nickname === 'string' ? entry.nickname.trim() : '';
      if (entry.action !== 'submit' || !nickname || nickname.length > 24 || /[\u0000-\u001f\u007f]/u.test(nickname)) {
        return json(response, 400, { error: 'invalid_record' });
      }
      if (started.meters === null) return json(response, 409, { error: 'run_not_finished' });
      const result = insert.run(run, nickname, started.meters);
      const stored = bySubmission.get(run);
      if (stored.nickname !== nickname || stored.meters !== started.meters) {
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
