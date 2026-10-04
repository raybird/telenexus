import { readFileSync, readdirSync } from 'node:fs';

export function parseStat(raw) {
  const end = raw.lastIndexOf(')');
  const fields = raw.slice(end + 2).trim().split(/\s+/);
  return {
    pid: Number(raw.slice(0, raw.indexOf(' '))),
    comm: raw.slice(raw.indexOf('(') + 1, end),
    state: fields[0],
    ppid: Number(fields[1]),
    pgid: Number(fields[2]),
    sid: Number(fields[3]),
    starttime: fields[19],
  };
}

export function snapshot() {
  return readdirSync('/proc').filter(name => /^\d+$/.test(name)).flatMap(name => {
    try {
      const item = parseStat(readFileSync(`/proc/${name}/stat`, 'utf8'));
      item.argv = readFileSync(`/proc/${name}/cmdline`, 'utf8').replaceAll('\0', ' ').trim();
      return [item];
    } catch { return []; }
  });
}
