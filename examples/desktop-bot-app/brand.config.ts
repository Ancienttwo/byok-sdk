/** The only white-label entry of the desktop app. A fork edits this file and nothing else to rebrand. */
export interface BrandConfig {
  /** Window title and the application name the OS shows. */
  readonly productName: string;
  /** https origins that links in the UI may open in the system browser; every other link is dropped. */
  readonly externalOrigins: readonly string[];
}

const brand: BrandConfig = {
  productName: 'BYOK Bots',
  externalOrigins: [],
};

export default brand;
