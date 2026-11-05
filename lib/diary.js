// Owner-private diary storage. Markdown, human-readable, local only.
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function todayIn(timeZone = 'Asia/Tokyo') {
  return new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date());
}

function safeDate(value, timeZone) {
  const date = String(value || '').trim() || todayIn(timeZone);
  if (!DATE.test(date)) throw new Error('date-invalid');
  return date;
}

export function diaryPath(dir, date, timeZone = 'Asia/Tokyo') {
  return join(String(dir), `${safeDate(date, timeZone)}.md`);
}

export function appendDiary({ dir, date, title, mood, body, timeZone = 'Asia/Tokyo', now = new Date() }) {
  const day = safeDate(date, timeZone);
  const text = String(body ?? '').trim();
  if (!text) throw new Error('body-required');
  if (text.length > 6000) throw new Error('body-too-long');
  const heading = String(title ?? '').trim().slice(0, 80);
  const moodText = String(mood ?? '').trim().slice(0, 40);
  mkdirSync(String(dir), { recursive: true, mode: 0o700 });
  const path = join(String(dir), `${day}.md`);
  const time = new Intl.DateTimeFormat('en-GB', {
    timeZone, hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(now);
  const section = [
    `## ${time}${heading ? ` ${heading}` : ''}`,
    moodText ? `心情：${moodText}` : '',
    '',
    text,
  ].filter((line, index) => line !== '' || index > 1).join('\n');
  if (!existsSync(path)) {
    writeFileSync(path, `# ${day}\n\n${section}\n`, { mode: 0o600 });
  } else {
    appendFileSync(path, `\n\n---\n\n${section}\n`, { mode: 0o600 });
  }
  return { ok: true, date: day, path, appended: true };
}

export function readDiary({ dir, date, timeZone = 'Asia/Tokyo' }) {
  const day = safeDate(date, timeZone);
  const path = join(String(dir), `${day}.md`);
  if (!existsSync(path)) return { ok: false, date: day, reason: 'not-found' };
  return { ok: true, date: day, path, content: readFileSync(path, 'utf8') };
}

export function listDiary({ dir, limit = 10 } = {}) {
  if (!existsSync(String(dir))) return [];
  return readdirSync(String(dir))
    .filter((name) => /^\d{4}-\d{2}-\d{2}\.md$/.test(name))
    .map((name) => {
      const path = join(String(dir), name);
      return { date: name.slice(0, 10), path, size: statSync(path).size, mtimeMs: statSync(path).mtimeMs };
    })
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, Math.max(1, Number(limit) || 10));
}
