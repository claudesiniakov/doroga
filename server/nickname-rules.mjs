/**
 * Проверка ников для таблицы рекордов. Один и тот же модуль используют клиент
 * (мгновенная подсказка) и сервер (последняя линия защиты).
 *
 * Это фильтр первой линии, а не полноценная модерация: списки заведомо неполные,
 * их стоит дополнять по жалобам. Проверка идёт по «сплющенной» строке — без
 * пробелов, знаков и с заменой цифр-двойников, чтобы не обходили «с л а в а».
 */

export const NICKNAME_MAX = 24;

const LEET = { '0': 'о', '1': 'и', '3': 'е', '4': 'а', '5': 'с', '6': 'б', '7': 'т', '8': 'в', '9': 'д', '@': 'а', '$': 'с' };

const REASONS = {
  profanity: 'Мат и оскорбления в нике запрещены',
  politics: 'Политические лозунги и тема конфликта в нике запрещены',
  hate: 'Символика ненависти в нике запрещена',
  violence: 'Призывы к насилию в нике запрещены',
};

/** Корни и фразы, которые ищем в строке без разделителей. */
const PROFANITY = [
  'хуй', 'хуя', 'хуе', 'хуё', 'пизд', 'бляд', 'блят', 'ебат', 'ебал', 'ебан', 'ебуч', 'залуп',
  'гандон', 'мудак', 'мудил', 'долбое', 'долбоё', 'нахуй', 'ахуе', 'охуе', 'сучк', 'шлюх',
  'проститут', 'жоп', 'ниггер', 'faggot', 'пидар', 'пидор', 'педик',
];
const PROFANITY_WORDS = ['бля', 'блядь', 'сука', 'суки', 'суке', 'суку', 'сучара', 'манда'];
const INSULTS = [
  'дурак', 'дура', 'идиот', 'дебил', 'кретин', 'лох', 'чмо', 'лошара', 'тупица',
  'дегенерат', 'выродок', 'мразь', 'тварь', 'ублюдок', 'гнида', 'манда',
];
const HATE = [
  '1488', 'heil', 'хайль', 'зигхайль', 'sieg', 'гитлер', 'hitler', 'нацист', 'нацизм',
  'nazi', 'ваффен', 'фашист', 'фашизм', 'геноцид', 'скинхед', 'kkk',
];
const POLITICS = [
  'славаукраин', 'славаукраїн', 'героямслава', 'украин', 'україн', 'бандера', 'бандеров',
  'хохол', 'хохляцк', 'москал', 'рашист', 'укроп', 'кацап', 'путлер', 'путін',
];
const VIOLENCE = [
  'убей', 'убиват', 'сдохни', 'застрел', 'взорв', 'повесить', 'сжеч', 'призывкнасилию',
  'резать',
];

/** Короткие слова проверяем целиком, иначе «лох» найдётся в «блохе». */
const HATE_WORDS = ['88', '1488'];
const POLITICS_WORDS = ['всу', 'азов'];

const compact = (text) => text.toLowerCase().normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, '');
const compactLeet = (text) => compact(text.replace(/[013456789@$]/g, (c) => LEET[c] ?? c));

/**
 * @param {string} raw
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function checkNickname(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return { ok: false, reason: 'Ник не может быть пустым' };
  if (text.length > NICKNAME_MAX) return { ok: false, reason: `Ник длиннее ${NICKNAME_MAX} символов` };
  if (/[\u0000-\u001f\u007f]/u.test(text)) return { ok: false, reason: 'В нике есть недопустимые символы' };

  const flat = compact(text);
  const flatLeet = compactLeet(text);
  const words = text.toLowerCase().normalize('NFKC').split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const includes = (list) => list.some((item) => flat.includes(item) || flatLeet.includes(item));
  const hasWord = (list) => list.some((item) => words.includes(item));

  if (includes(HATE) || hasWord(HATE_WORDS)) return { ok: false, reason: REASONS.hate };
  if (includes(POLITICS) || hasWord(POLITICS_WORDS)) return { ok: false, reason: REASONS.politics };
  if (includes(VIOLENCE)) return { ok: false, reason: REASONS.violence };
  if (includes(PROFANITY) || hasWord(PROFANITY_WORDS) || hasWord(INSULTS)) return { ok: false, reason: REASONS.profanity };
  return { ok: true };
}
