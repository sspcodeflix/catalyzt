/**
 * Files attached to a chat message. The bytes go to the blob store, the metadata and any text
 * Catalyzt could read go to SQLite. Only text formats are read in this build; everything else is
 * kept and shown as "stored, not readable", never as processed. An attachment belongs to the
 * application and the person who uploaded it, and to the first chat it is used in.
 */
import { createHash, randomUUID } from 'node:crypto';

import { containsSecret } from '../src/lib/guardrails';
import type { AppRecord, HorizonDb, PersonRecord } from './db';
import type { BlobStore } from './storage';

export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
export const MAX_FILES_PER_UPLOAD = 10;
/** Text kept per attachment for retrieval; longer files are cut and say so. */
export const MAX_TEXT_CHARS = 200_000;

export class AttachmentError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export type AttachmentStatus = 'ready' | 'stored' | 'failed';

export interface AttachmentView {
  id: string;
  filename: string;
  mime: string;
  size: number;
  /** ready: Catalyzt can read its text; stored: kept, but not readable in this build. */
  status: AttachmentStatus;
  note: string | null;
  textChars: number;
  chatId: string | null;
  createdAt: string;
}

/** What a run gets for each attachment: the text when there is one, otherwise why not. */
export interface ResolvedAttachment {
  id: string;
  filename: string;
  text: string | null;
  note: string | null;
}

const TEXT_TYPES: Record<string, string> = {
  txt: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  json: 'application/json',
  log: 'text/plain',
  xml: 'application/xml',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  toml: 'text/plain',
  ini: 'text/plain',
  properties: 'text/plain',
  sql: 'text/plain',
  html: 'text/html',
  htm: 'text/html',
  feature: 'text/plain',
  java: 'text/x-java',
  kt: 'text/x-kotlin',
  py: 'text/x-python',
  ts: 'text/typescript',
  tsx: 'text/typescript',
  js: 'text/javascript',
  jsx: 'text/javascript',
  go: 'text/x-go',
  cs: 'text/x-csharp',
  rb: 'text/x-ruby',
  sh: 'text/x-shellscript',
  proto: 'text/plain',
};
const STORED_ONLY: Record<string, [string, string]> = {
  pdf: ['application/pdf', 'PDF text extraction is not available in this build; the file is kept but Catalyzt cannot read it yet.'],
  docx: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'Word documents are kept but not read in this build.'],
  xlsx: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Spreadsheets are kept but not read in this build; export the sheet as CSV to make it readable.'],
  png: ['image/png', 'Images are kept but not read in this build.'],
  jpg: ['image/jpeg', 'Images are kept but not read in this build.'],
  jpeg: ['image/jpeg', 'Images are kept but not read in this build.'],
  zip: ['application/zip', 'Archives are kept but not read; attach the files inside instead.'],
};

const ext = (name: string) => name.split('.').pop()?.toLowerCase() ?? '';
const safeName = (name: string) => name.replace(/[\\/]/g, '_').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 200) || 'file';

/** Reads text from formats Catalyzt understands. Binary content in a "text" file is refused honestly. */
export function extractText(filename: string, data: Buffer): { text: string | null; mime: string; status: AttachmentStatus; note: string | null } {
  const e = ext(filename);
  if (e in TEXT_TYPES) {
    if (data.subarray(0, 8000).includes(0)) return { text: null, mime: 'application/octet-stream', status: 'stored', note: 'The file is not text, so Catalyzt cannot read it.' };
    let text = data.toString('utf8').replace(/\r\n?/g, '\n');
    let note: string | null = null;
    if (text.length > MAX_TEXT_CHARS) {
      text = text.slice(0, MAX_TEXT_CHARS);
      note = `Only the first ${MAX_TEXT_CHARS.toLocaleString()} characters are read.`;
    }
    if (!text.trim()) return { text: null, mime: TEXT_TYPES[e], status: 'stored', note: 'The file is empty.' };
    return { text, mime: TEXT_TYPES[e], status: 'ready', note };
  }
  if (e in STORED_ONLY) return { text: null, mime: STORED_ONLY[e][0], status: 'stored', note: STORED_ONLY[e][1] };
  return { text: null, mime: 'application/octet-stream', status: 'stored', note: `.${e || '?'} files are kept but not read in this build.` };
}

export interface UploadInput {
  filename: string;
  data: Buffer;
}

/** Stores uploads for a person in an application. Returns what was kept and one message per refused file. */
export async function addAttachments(db: HorizonDb, store: BlobStore, app: AppRecord, user: PersonRecord, files: UploadInput[], chatId: string | null): Promise<{ attachments: AttachmentView[]; errors: string[] }> {
  if (files.length === 0) throw new AttachmentError(400, 'Choose at least one file.');
  if (files.length > MAX_FILES_PER_UPLOAD) throw new AttachmentError(400, `Attach at most ${MAX_FILES_PER_UPLOAD} files at a time.`);
  if (chatId) {
    const chat = db.getChat(chatId);
    if (!chat || chat.applicationId !== app.id) throw new AttachmentError(404, 'This chat does not exist in this application.');
    if (chat.createdBy !== user.id) throw new AttachmentError(403, 'Only the person who started this chat can attach files to it.');
  }
  const out: AttachmentView[] = [];
  const errors: string[] = [];
  for (const f of files) {
    const filename = safeName(f.filename);
    if (f.data.length === 0) {
      errors.push(`${filename}: the file is empty.`);
      continue;
    }
    if (f.data.length > MAX_ATTACHMENT_BYTES) {
      errors.push(`${filename} is over the ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB limit.`);
      continue;
    }
    const id = `att-${randomUUID()}`;
    const key = `${app.id}/${id}`;
    const { text, mime, status, note } = extractText(filename, f.data);
    // F05: a file that holds what looks like a secret is not kept at all; the bytes never reach the store.
    if (text && containsSecret(text)) {
      errors.push(`${filename}: contains what looks like a password, key or token, so it was not kept. Remove it (and rotate it if it is real), then attach the file again.`);
      continue;
    }
    try {
      await store.put(key, f.data);
    } catch (e) {
      errors.push(`${filename}: could not be stored (${(e as Error).message}).`);
      continue;
    }
    db.addAttachment({ id, app: app.id, chatId, filename, mime, size: f.data.length, sha256: createHash('sha256').update(f.data).digest('hex'), storageKey: key, status, note, text, userId: user.id });
    out.push(db.getAttachment(id)!);
  }
  return { attachments: out, errors };
}

/**
 * The attachments a run may read: each must exist in this application (anything else is not
 * disclosed), belong to this person, and be free or already bound to this chat. The workflow binds
 * free ones to the chat once the message is stored, so a file used in one chat cannot be pulled
 * into another afterwards.
 */
export function attachmentsForRun(db: HorizonDb, app: string, userId: string, ids: string[], chatId: string | undefined): ResolvedAttachment[] {
  const out: ResolvedAttachment[] = [];
  for (const id of [...new Set(ids)].slice(0, MAX_FILES_PER_UPLOAD)) {
    const a = db.getAttachment(id);
    if (!a || a.applicationId !== app) throw new AttachmentError(404, `Attachment ${id} does not exist in this application.`);
    if (a.createdBy !== userId) throw new AttachmentError(403, `${a.filename} was attached by someone else.`);
    if (a.chatId && chatId && a.chatId !== chatId) throw new AttachmentError(409, `${a.filename} belongs to another chat.`);
    out.push({ id, filename: a.filename, text: a.status === 'ready' ? db.attachmentText(id) : null, note: a.note });
  }
  return out;
}
