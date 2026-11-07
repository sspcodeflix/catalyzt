/**
 * Uploads for the composer. Bytes go to the server at once (POST /api/attachments); the chip the
 * person sees reflects what the server kept and whether Catalyzt can read it. Nothing is sent with
 * a message unless the server has it.
 */
import { http } from './session';

export interface UploadedAttachment {
  id: string;
  filename: string;
  mime: string;
  size: number;
  /** ready: Catalyzt can read it; stored: kept but not readable in this build. */
  status: 'ready' | 'stored' | 'failed';
  note: string | null;
  textChars: number;
}

const toBase64 = (f: File) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
    r.onerror = () => reject(r.error ?? new Error('Could not read the file.'));
    r.readAsDataURL(f);
  });

/** Uploads one file. Resolves with the stored attachment, or rejects with the server's reason. */
export async function uploadAttachment(file: File, chatId?: string): Promise<UploadedAttachment> {
  const contentBase64 = await toBase64(file);
  const res = await http('/api/attachments', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ files: [{ filename: file.name, contentBase64 }], chatId }),
  });
  const body = (await res.json().catch(() => ({}))) as { attachments?: UploadedAttachment[]; errors?: string[]; error?: string };
  if (!res.ok) throw new Error(body.error ?? `Upload failed (${res.status}).`);
  if (body.attachments?.[0]) return body.attachments[0];
  throw new Error(body.errors?.[0] ?? 'The file was not stored.');
}
