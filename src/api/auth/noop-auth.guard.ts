import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';

/**
 * Decisão (contrato §2): autenticação a cargo do candidato e sem pontos.
 * Guard no-op como ponto de extensão para IdP externo (Keycloak/Zitadel).
 * Health permanece aberto; este guard pode ser aplicado aos demais endpoints.
 */
@Injectable()
export class NoopAuthGuard implements CanActivate {
  canActivate(_context: ExecutionContext): boolean {
    return true;
  }
}

/** Porta futura para identidade do provedor (OIDC / IdP). */
export interface ProviderIdentityPort {
  resolveProviderId(authorizationHeader?: string): Promise<string | null>;
}

export const PROVIDER_IDENTITY_PORT = Symbol('PROVIDER_IDENTITY_PORT');
