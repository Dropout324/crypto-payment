import { Module } from '@nestjs/common';
import { APP_CONFIG, loadConfig } from './config/env.js';
import { PrismaModule } from './database/prisma.module.js';
import { RedisModule } from './common/redis.module.js';
import { exchangeRateServiceProvider } from './common/exchange-rate.provider.js';
import { IdempotencyService } from './common/idempotency.service.js';
import { HealthController } from './health/health.controller.js';
import { InvoicesController } from './invoices/invoices.controller.js';
import { PublicInvoicesController } from './invoices/public-invoices.controller.js';
import { InvoicesService } from './invoices/invoices.service.js';
import { AddressesController } from './merchant/addresses.controller.js';
import { AddressesService } from './merchant/addresses.service.js';
import { AuthController } from './auth/auth.controller.js';
import { AuthService } from './auth/auth.service.js';
import { TransactionsController } from './transactions/transactions.controller.js';
import { TransactionsService } from './transactions/transactions.service.js';
import { BalanceController } from './merchant/balance.controller.js';
import { BalanceService } from './merchant/balance.service.js';
import { MerchantTransactionsController } from './merchant/merchant-transactions.controller.js';
import { MerchantTransactionsService } from './merchant/merchant-transactions.service.js';
import { WebhooksTestController } from './webhooks/webhooks-test.controller.js';
import { WebhooksTestService } from './webhooks/webhooks-test.service.js';
import { ApiKeysController } from './merchant/api-keys.controller.js';
import { ApiKeysService } from './merchant/api-keys.service.js';
import { WebhookEndpointsController } from './merchant/webhook-endpoints.controller.js';
import { WebhookEndpointsService } from './merchant/webhook-endpoints.service.js';
import { MerchantMembersController } from './merchant/members.controller.js';
import { MerchantMembersService } from './merchant/members.service.js';
import { InvoicesListController } from './merchant/invoices-list.controller.js';
import { InvoicesListService } from './merchant/invoices-list.service.js';
import { BalanceMeController } from './merchant/balance-me.controller.js';
import { TransactionsMeController } from './merchant/transactions-me.controller.js';
import { MerchantSettingsController } from './merchant/settings.controller.js';
import { MerchantSettingsService } from './merchant/settings.service.js';
import { AuditLogService } from './common/audit-log.service.js';
import { AdminMerchantsController } from './admin/admin-merchants.controller.js';
import { AdminMerchantsService } from './admin/admin-merchants.service.js';
import { AdminComplianceController } from './admin/admin-compliance.controller.js';
import { AdminComplianceService } from './admin/admin-compliance.service.js';
import { AdminReconciliationController } from './admin/admin-reconciliation.controller.js';
import { AdminReconciliationService } from './admin/admin-reconciliation.service.js';
import { AdminRefundsController } from './admin/admin-refunds.controller.js';
import { AdminRefundsService } from './admin/admin-refunds.service.js';
import { AdminSettlementsController } from './admin/admin-settlements.controller.js';
import { AdminSettlementsService } from './admin/admin-settlements.service.js';
import { AdminAuditLogsController } from './admin/admin-audit-logs.controller.js';
import { AdminAuditLogsService } from './admin/admin-audit-logs.service.js';
import { AdminSigningController } from './signing/admin-signing.controller.js';
import { AdminSigningService } from './signing/admin-signing.service.js';
import { signingServiceProvider } from './signing/signing.provider.js';
import { financialMetricsProvider, financialMetricsRegistryProvider } from './observability/financial-metrics.provider.js';

@Module({
  imports: [PrismaModule, RedisModule],
  controllers: [
    HealthController,
    InvoicesController,
    PublicInvoicesController,
    AddressesController,
    AuthController,
    TransactionsController,
    BalanceController,
    MerchantTransactionsController,
    WebhooksTestController,
    ApiKeysController,
    WebhookEndpointsController,
    MerchantMembersController,
    InvoicesListController,
    BalanceMeController,
    TransactionsMeController,
    MerchantSettingsController,
    AdminMerchantsController,
    AdminComplianceController,
    AdminReconciliationController,
    AdminRefundsController,
    AdminSettlementsController,
    AdminAuditLogsController,
    AdminSigningController,
  ],
  providers: [
    { provide: APP_CONFIG, useValue: loadConfig() },
    exchangeRateServiceProvider,
    IdempotencyService,
    InvoicesService,
    AddressesService,
    AuthService,
    TransactionsService,
    BalanceService,
    MerchantTransactionsService,
    WebhooksTestService,
    ApiKeysService,
    WebhookEndpointsService,
    MerchantMembersService,
    InvoicesListService,
    MerchantSettingsService,
    AuditLogService,
    AdminMerchantsService,
    AdminComplianceService,
    AdminReconciliationService,
    AdminRefundsService,
    AdminSettlementsService,
    AdminAuditLogsService,
    AdminSigningService,
    signingServiceProvider,
    financialMetricsRegistryProvider,
    financialMetricsProvider,
  ],
})
export class AppModule {}
