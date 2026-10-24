/**
 * A blob request the server answered with a failure status. The daemon reads
 * the status, and whether the signed content URL gave it, to tell a final
 * refusal from one worth retrying. It is internal: no public declaration
 * names it.
 */
export class BlobHttpError extends Error {
  constructor(message: string, readonly status: number, readonly signedUrl = false) {
    super(message);
    this.name = 'BlobHttpError';
  }
}
