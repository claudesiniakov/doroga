export const MAX_NICKNAME_LENGTH = 24;

interface RecordEntry {
  nickname: string;
  id: number;
  durationMs: number;
}

const endpoint = './api/records?metric=time';

export async function loadRecords(): Promise<RecordEntry[]> {
  const response = await fetch(endpoint, { cache: 'no-store', signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error('Не удалось загрузить рекорды');
  return response.json();
}

async function postRecord(body: object) {
  const response = await fetch(endpoint, {
    method: 'POST',
    signal: AbortSignal.timeout(8000),
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error('Не удалось сохранить результат');
  return response.json();
}

export async function startRecordRun(): Promise<string> {
  const { run } = await postRecord({ action: 'start' });
  if (typeof run !== 'string' || !/^[a-f0-9]{32}$/.test(run)) throw new Error('Заезд не зарегистрирован');
  return run;
}

export async function finishRecordRun(run: string, durationMs: number): Promise<void> {
  await postRecord({ action: 'finish', run, durationMs });
}

export async function saveRecord(nickname: string, run: string): Promise<{ place: number; id: number }> {
  return postRecord({ action: 'submit', run, nickname });
}

const distanceFormat = new Intl.NumberFormat('ru', { maximumFractionDigits: 3 });

export function formatRecordDistance(meters: number) {
  return `${distanceFormat.format(meters / 1000)} км`;
}

const daysFormat = new Intl.NumberFormat('ru', { style: 'unit', unit: 'day', unitDisplay: 'long' });

export function formatRecordDays(durationMs: number) {
  // Одна секунда активного заезда соответствует одному игровому дню.
  return daysFormat.format(Math.floor(durationMs / 1000));
}
