import { PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';

export interface ReceiptFiles {
  /** Stores the original file; returns its key. Originals are kept so extraction can be re-run. */
  put(input: { receiptId: string; receivedAt: Date; bytes: Uint8Array; mimeType: string }): Promise<string>;
}

const EXT: Record<string, string> = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

export class S3ReceiptFiles implements ReceiptFiles {
  constructor(private readonly s3: S3Client, private readonly bucket: string) {}

  async put({ receiptId, receivedAt, bytes, mimeType }: Parameters<ReceiptFiles['put']>[0]): Promise<string> {
    const key = `receipts/${receivedAt.toISOString().slice(0, 7)}/${receiptId}.${EXT[mimeType] ?? 'bin'}`;
    await this.s3.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: bytes, ContentType: mimeType }),
    );
    return key;
  }
}
