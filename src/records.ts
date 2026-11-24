export const MAX_NICKNAME_LENGTH = 24;

interface RecordEntry {
  nickname: string;
  meters: number;
}

const endpoint = './api/records';

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

export async function finishRecordRun(run: string, meters: number): Promise<void> {
  await postRecord({ action: 'finish', run, meters });
}

export async function saveRecord(nickname: string, run: string): Promise<number> {
  const { place } = await postRecord({ action: 'submit', run, nickname });
  return place;
}

const distanceFormat = new Intl.NumberFormat('ru', { maximumFractionDigits: 3 });

export function formatRecordDistance(meters: number) {
  return `${distanceFormat.format(meters / 1000)} км`;
}
