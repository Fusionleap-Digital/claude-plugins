// Minimal DNS-over-UDP TXT lookup for names Node's resolver refuses, such as
// a label that is a literal "@" (Route 53 shows it as \100.example.com).
// Asks the system's first configured resolver. Returns null when the name
// doesn't exist or has no TXT records.

import { createSocket } from 'node:dgram';
import { getServers } from 'node:dns';
import { isIP } from 'node:net';
import { randomBytes } from 'node:crypto';

function encodeName(labels) {
  const parts = labels.map((l) => {
    const b = Buffer.from(l, 'utf8');
    return Buffer.concat([Buffer.from([b.length]), b]);
  });
  return Buffer.concat([...parts, Buffer.from([0])]);
}

function skipName(buf, off) {
  while (off < buf.length) {
    const len = buf[off];
    if (len === 0) return off + 1;
    if ((len & 0xc0) === 0xc0) return off + 2;
    off += len + 1;
  }
  return off;
}

export function parseTxtAnswer(buf, id) {
  if (buf.readUInt16BE(0) !== id) throw new Error('DNS id mismatch');
  const rcode = buf[3] & 0x0f;
  if (rcode === 3) return null; // NXDOMAIN
  if (rcode !== 0) throw new Error(`DNS rcode ${rcode}`);
  const qd = buf.readUInt16BE(4);
  const an = buf.readUInt16BE(6);
  let off = 12;
  for (let i = 0; i < qd; i++) off = skipName(buf, off) + 4;
  const records = [];
  for (let i = 0; i < an; i++) {
    off = skipName(buf, off);
    const type = buf.readUInt16BE(off);
    const rdlen = buf.readUInt16BE(off + 8);
    off += 10;
    if (type === 16) {
      const strings = [];
      let p = off;
      while (p < off + rdlen) {
        const len = buf[p];
        strings.push(buf.subarray(p + 1, p + 1 + len).toString('utf8'));
        p += len + 1;
      }
      records.push(strings);
    }
    off += rdlen;
  }
  return records.length ? records : null;
}

export async function rawResolveTxt(labels, { server, timeoutMs = 4000 } = {}) {
  const ns = server || getServers().find((s) => isIP(s)) || '1.1.1.1';
  const id = randomBytes(2).readUInt16BE(0);
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id, 0);
  header.writeUInt16BE(0x0100, 2); // recursion desired
  header.writeUInt16BE(1, 4);
  const query = Buffer.concat([header, encodeName(labels), Buffer.from([0, 16, 0, 1])]);
  const sock = createSocket(isIP(ns) === 6 ? 'udp6' : 'udp4');
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('DNS timeout')), timeoutMs);
      sock.once('error', (e) => { clearTimeout(timer); reject(e); });
      sock.once('message', (msg) => {
        clearTimeout(timer);
        try { resolve(parseTxtAnswer(msg, id)); } catch (e) { reject(e); }
      });
      sock.send(query, 53, ns);
    });
  } finally {
    sock.close();
  }
}
