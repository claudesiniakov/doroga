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

export function newRecordSubmission() {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function saveRecord(nickname: string, meters: number, submission: string): Promise<number> {
  const response = await fetch(endpoint, {
    method: 'POST',
    signal: AbortSignal.timeout(8000),
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nickname, meters, submission }),
  });
  if (!response.ok) throw new Error('Не удалось сохранить результат');
  const { place } = await response.json();
  return place;
}

const distanceFormat = new Intl.NumberFormat('ru', { maximumFractionDigits: 3 });

export function formatRecordDistance(meters: number) {
  return `${distanceFormat.format(meters / 1000)} км`;
}
