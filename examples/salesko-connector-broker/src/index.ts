export {
  CONNECTOR_BROKER_ERROR_CODES,
  ConnectorBrokerError,
  ConnectorProfileIdSchema,
  EmailDomainSchema,
  GmailConnectorBroker,
  GmailConnectorPolicySchema,
  GmailCorrespondenceSchema,
  GmailSearchInputSchema,
  NormalizedEmailAddressSchema,
} from './broker';
export type {
  ConnectorBrokerErrorCode,
  GmailConnectorBrokerOptions,
  GmailConnectorPolicy,
  GmailConnectorPolicyInput,
  GmailCorrespondence,
  GmailProviderSearchInput,
  GmailReadProvider,
  GmailSearchInput,
  GmailSearchResult,
  OAuthAccessTokenSource,
} from './broker';

export {
  GOOGLE_AUTHORIZATION_ENDPOINT,
  GOOGLE_GMAIL_PROFILE_ENDPOINT,
  GOOGLE_GMAIL_READONLY_SCOPE,
  GOOGLE_REVOKE_ENDPOINT,
  GOOGLE_TOKEN_ENDPOINT,
  GoogleOAuthAccessTokenSource,
  GoogleOAuthClientCredentialSchema,
  GoogleOAuthRefreshCredentialSchema,
  authorizeGoogleGmailWithLoopback,
  configureGoogleOAuthClient,
  createGoogleAuthorizationRequest,
  exchangeGoogleAuthorizationCode,
  forgetGoogleOAuthConnection,
  googleOAuthClientSecretName,
  googleOAuthRefreshSecretName,
  readGoogleOAuthStatus,
  revokeGoogleOAuthConnection,
} from './google-oauth';
export type {
  GoogleAuthorizationCode,
  GoogleAuthorizationRequest,
  GoogleFetch,
  GoogleOAuthClientCredential,
  GoogleOAuthRefreshCredential,
  GoogleOAuthStatus,
} from './google-oauth';

export {
  GOOGLE_GMAIL_MESSAGES_ENDPOINT,
  GoogleGmailReadProvider,
} from './google-gmail-provider';
export type { GoogleGmailReadProviderOptions } from './google-gmail-provider';

export {
  GMAIL_SEARCH_TOOL_NAME,
  MAX_MCP_REQUEST_BYTES,
  handleConnectorMcpRequest,
  serveConnectorMcp,
} from './mcp-server';
export type { ConnectorMcpResponse } from './mcp-server';

export {
  SALESKO_CONNECTOR_SECRET_SERVICE_PREFIX,
  createSaleskoConnectorSecretStore,
} from './platform-store';
