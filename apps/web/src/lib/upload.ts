/**
 * PUTs a file straight to object storage with a pre-signed URL. XMLHttpRequest rather than
 * fetch, because fetch cannot report upload progress. No credentials or Authorization header:
 * the signature in the URL is the only authority, and storage checks the signed size and type.
 */
export function putFile(
  target: { url: string; headers: Record<string, string> },
  file: Blob,
  onProgress?: (fraction: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', target.url);
    for (const [name, value] of Object.entries(target.headers)) xhr.setRequestHeader(name, value);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress?.(event.loaded / event.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error(`The upload was rejected (${String(xhr.status)})`));
    };
    xhr.onerror = () => {
      reject(new Error('The upload failed. Check your connection and try again.'));
    };
    xhr.send(file);
  });
}
