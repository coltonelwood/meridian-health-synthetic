import { createReadStream } from 'fs';
import { Transform } from 'stream';
import * as iconv from 'iconv-lite';

/**
 * Detect the encoding of a file by reading the first few bytes.
 *
 * The legacy EHR system exports in various encodings depending on which
 * module exported the data:
 * - Patient demographics: usually UTF-8 (but sometimes Windows-1252)
 * - Billing/claims: Windows-1252 (because it runs on a Windows server)
 * - Provider directory: UTF-8 with BOM
 *
 * This is a best-effort detection - for edge cases we fall back to UTF-8
 * and hope for the best.
 */
export async function detectEncoding(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stream = createReadStream(filePath, { start: 0, end: 4096 });
    const chunks: Buffer[] = [];

    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('end', () => {
      const buffer = Buffer.concat(chunks);

      // Check for BOM
      if (buffer[0] === 0xEF && buffer[1] === 0xBB && buffer[2] === 0xBF) {
        resolve('utf-8');
        return;
      }
      if (buffer[0] === 0xFF && buffer[1] === 0xFE) {
        resolve('utf-16le');
        return;
      }
      if (buffer[0] === 0xFE && buffer[1] === 0xFF) {
        resolve('utf-16be');
        return;
      }

      // Heuristic: look for bytes > 127 that are valid in Windows-1252
      // but not valid UTF-8 sequences
      let hasHighBytes = false;
      let invalidUtf8 = false;

      for (let i = 0; i < buffer.length; i++) {
        if (buffer[i] > 127) {
          hasHighBytes = true;
          // check if it's a valid UTF-8 continuation
          if ((buffer[i] & 0xE0) === 0xC0) {
            // 2-byte sequence
            if (i + 1 >= buffer.length || (buffer[i + 1] & 0xC0) !== 0x80) {
              invalidUtf8 = true;
              break;
            }
            i++;
          } else if ((buffer[i] & 0xF0) === 0xE0) {
            // 3-byte sequence
            if (i + 2 >= buffer.length ||
                (buffer[i + 1] & 0xC0) !== 0x80 ||
                (buffer[i + 2] & 0xC0) !== 0x80) {
              invalidUtf8 = true;
              break;
            }
            i += 2;
          } else if ((buffer[i] & 0xC0) === 0x80) {
            // unexpected continuation byte
            invalidUtf8 = true;
            break;
          }
        }
      }

      if (hasHighBytes && invalidUtf8) {
        // Probably Windows-1252 or Latin-1
        resolve('windows-1252');
      } else {
        resolve('utf-8');
      }
    });
    stream.on('error', reject);
  });
}

/**
 * Create a transform stream that converts the given encoding to UTF-8.
 *
 * WORKAROUND: Excel-exported CSVs have some quirks:
 * 1. They use Windows-1252 encoding even when you "Save as CSV UTF-8"
 *    (Microsoft, please.)
 * 2. They wrap fields with commas in double quotes, but don't escape
 *    quotes inside the field consistently
 * 3. They sometimes have an extra trailing comma on every row
 * 4. They use \r\n line endings (fine, but the csv-parse library
 *    sometimes chokes on them when combined with the encoding issues)
 *
 * We handle all of these here so the migrators don't have to care.
 */
export function normalizeEncoding(encoding: string): Transform {
  if (encoding === 'utf-8') {
    // still need to handle CRLF and trailing commas
    return new Transform({
      transform(chunk, _encoding, callback) {
        let str = chunk.toString('utf-8');

        // strip BOM if present
        if (str.charCodeAt(0) === 0xFEFF) {
          str = str.substring(1);
        }

        // normalize line endings
        str = str.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

        // remove trailing commas on each line (Excel artifact)
        // but be careful not to remove commas that are part of data
        // only remove a trailing comma if it's followed by a newline or EOF
        str = str.replace(/,\n/g, '\n');
        // TODO: ^^ this is actually wrong - it removes the last field if it's empty
        // which is a valid CSV case. But the legacy data doesn't have trailing
        // empty fields so it works for now. Fix this properly later.

        callback(null, str);
      },
    });
  }

  // For non-UTF-8 encodings, transcode through iconv
  const decoder = iconv.getDecoder(encoding);
  return new Transform({
    transform(chunk, _encoding, callback) {
      try {
        let str = decoder.write(chunk);

        // same cleanup as above
        str = str.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        str = str.replace(/,\n/g, '\n');

        callback(null, Buffer.from(str, 'utf-8'));
      } catch (err) {
        callback(err as Error);
      }
    },
    flush(callback) {
      const remaining = decoder.end();
      if (remaining) {
        callback(null, Buffer.from(remaining, 'utf-8'));
      } else {
        callback();
      }
    },
  });
}

/**
 * Count the number of lines in a file (for progress bar).
 * Reads the whole file which is slow for large files but whatever,
 * it's a one-time cost at the start of migration.
 */
export async function countLines(filePath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    let count = 0;
    const stream = createReadStream(filePath);
    stream.on('data', (chunk: Buffer) => {
      for (let i = 0; i < chunk.length; i++) {
        if (chunk[i] === 0x0A) count++;
      }
    });
    stream.on('end', () => resolve(count));
    stream.on('error', reject);
  });
}
