export interface RuntimeReadOptions {
  /** Cancels the read and terminates the native processes it owns. */
  readonly signal?: AbortSignal;
}

export interface RuntimeAccountUsageOptions extends RuntimeReadOptions {
  /** Allows a reader to invoke one-shot CLI print mode. Defaults to false. */
  readonly allowPrintMode?: boolean;
}

export interface RuntimeListModelsOptions extends RuntimeReadOptions {
  /** Re-read the catalog even when this adapter has a cached result for the installation. */
  readonly refresh?: boolean;
}

/** A selector and optional native picker metadata. */
export interface RuntimeModelEntry {
  readonly id: string;
  readonly resolvedId?: string;
  readonly displayName?: string;
  readonly effortLevels?: readonly string[];
  readonly defaultEffort?: string;
  readonly effortUnavailableReason?: string;
  readonly serviceTiers?: readonly string[];
  /** Native picker labels and descriptions, in the same order as serviceTiers. */
  readonly serviceTierDetails?: readonly {
    readonly id: string;
    readonly displayName?: string;
    readonly description?: string;
  }[];
  readonly defaultServiceTier?: string;
  readonly disabled?: { readonly reason: string };
  readonly default?: true;
  readonly provider?: { readonly id: string; readonly displayName?: string };
}

export interface RuntimeUnsupportedVersion {
  readonly installedVersion?: string;
  readonly requiredVersion: string;
}

export type RuntimeModelCatalog =
  | { readonly kind: 'ok'; readonly models: readonly RuntimeModelEntry[] }
  | { readonly kind: 'unauthenticated'; readonly detail?: string }
  | { readonly kind: 'unsupported'; readonly reason: string; readonly code?: 'version_unsupported'; readonly installedVersion?: string; readonly requiredVersion?: string };

export interface RuntimeAccountUsageWindow {
  readonly label: string;
  /** Consumed fraction, between zero and one. */
  readonly usedRatio: number;
  /** Absolute UTC instant in ISO 8601 format. */
  readonly resetsAt?: string;
  readonly id?: string;
  readonly durationMs?: number;
  readonly scope?: { readonly kind: 'account' } | { readonly kind: 'model' | 'models'; readonly name: string };
}

export type RuntimeAccountUsageUnsupportedReason =
  | 'version_unsupported' | 'capability_unavailable' | 'unsupported_installation' | 'unsupported_auth_mode'
  | 'unsupported_auth_storage' | 'auth_configuration_unavailable' | 'endpoint_unavailable' | 'quota_unavailable'
  | 'print_mode_disabled';

/** Explicit local read of account quota. This result is private to the host. */
export type RuntimeAccountUsage =
  | { readonly kind: 'unavailable'; readonly reason: 'access_token_expired' }
  | { readonly kind: 'reauth_required'; readonly reason?: 'not_authenticated' | 'credentials_missing' | 'scope_missing' | 'credentials_rejected' }
  | { readonly kind: 'unsupported'; readonly reason?: RuntimeAccountUsageUnsupportedReason; readonly installedVersion?: string; readonly requiredVersion?: string }
  | {
      readonly kind: 'available';
      readonly plan?: string;
      readonly email?: string;
      readonly displayName?: string;
      readonly rateLimited: boolean;
      readonly windows: readonly RuntimeAccountUsageWindow[];
      readonly credits?: { readonly available: boolean; readonly unlimited?: boolean; readonly balance?: string };
      readonly limitResets?: {
        readonly available: number;
        readonly resets?: readonly {
          readonly id: string;
          readonly status: 'available' | 'redeeming' | 'redeemed' | 'unknown';
          readonly grantedAt?: string;
          readonly expiresAt?: string;
          readonly title?: string;
          readonly description?: string;
        }[];
      };
    };
