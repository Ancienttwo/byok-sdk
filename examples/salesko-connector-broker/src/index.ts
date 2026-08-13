export {
  CONNECTOR_BROKER_ERROR_CODES,
  ConnectorBrokerError,
  ConnectorProfileIdSchema,
  DEFAULT_MINIMUM_TOKEN_VALIDITY_MS,
  EmailDomainSchema,
  GmailConnectorBroker,
  GmailConnectorPolicySchema,
  GmailCorrespondenceSchema,
  GmailSearchInputSchema,
  NormalizedEmailAddressSchema,
  OAuthCredentialSchema,
  SecretStoreOAuthAccessTokenSource,
  gmailOAuthSecretName,
  provisionOAuthCredential,
  readOAuthCredentialStatus,
  revokeOAuthCredential,
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
  OAuthCredential,
  OAuthCredentialStatus,
} from './broker';

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
